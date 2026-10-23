/**
 * 备份包组装：把盘点结果变成一个自解释的 ZIP。
 *
 * 归档结构（根目录固定为 dsh-backup-<时间戳>/ 之外的内容，即条目直接以
 * manifest.json 开头，解压即得到一个可直接阅读的还原包）：
 *
 *   manifest.json          机器可读清单（插件、技能、来源、指纹、体积）
 *   README.md              人读的换机还原说明（含本次实际内容）
 *   restore.ps1            一键还原脚本
 *   profile/               profile 的清单与配置（package.json / cordis*.yml / lock）
 *   plugins/<安全名>/       每个第三方插件的实体文件
 *   skills/<名称>/          每个技能
 */

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { collectDirectory, writeZip } from './zip.js';
import { hashFile, hashTree, listPlugins, listSkills } from './inventory.js';

/** 备份包内插件目录的安全名：`@scope/name` → `@scope__name`。 */
export function safePluginDir(name) {
  return String(name).replace(/\//g, '__');
}

const PROFILE_FILES = [
  'package.json',
  'cordis.patch.yml',
  'cordis.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

/** 默认排除：版本库元数据、依赖树、以及明显的编辑器残留。 */
function defaultExclude(rel) {
  const first = rel.split('/')[0];
  if (first === '.git' || first === 'node_modules' || first === '.vs' || first === '.vscode') return true;
  if (rel.endsWith('.log')) return true;
  return false;
}

/**
 * 组装一个备份包。
 *
 * @param {object} options
 * @param {string} options.dshHome
 * @param {string} options.profileDir
 * @param {string} options.outPath 目标 zip 路径
 * @param {string} [options.cloudFolder] 归档到迅雷网盘的目标文件夹名（写进清单）
 * @param {boolean} [options.includePlugins]
 * @param {boolean} [options.includeSkills]
 * @param {(event: {phase:string, done:number, total:number, name?:string}) => void} [options.onProgress]
 */
export async function buildArchive(options) {
  const {
    dshHome,
    profileDir,
    outPath,
    cloudFolder = 'DSH-Backup',
    includePlugins = true,
    includeSkills = true,
    onProgress = () => {},
  } = options;

  const skillsDir = path.join(dshHome, 'skills');
  const profileName = path.basename(profileDir);

  onProgress({ phase: 'scan', done: 0, total: 1, name: '盘点插件与技能' });
  const plugins = includePlugins ? await listPlugins(profileDir) : [];
  const skills = includeSkills ? await listSkills(skillsDir) : [];

  const entries = [];
  const pluginRecords = [];
  const skillRecords = [];

  // --- profile 清单与配置 ---------------------------------------------------
  for (const file of PROFILE_FILES) {
    const abs = path.join(profileDir, file);
    if (existsSync(abs)) entries.push({ name: `profile/${file}`, path: abs });
  }

  // --- 插件实体 -------------------------------------------------------------
  if (includePlugins) {
    for (const plugin of plugins) {
      const record = {
        name: plugin.name,
        spec: plugin.spec,
        kind: plugin.kind,
        version: plugin.version,
        enabled: plugin.enabled,
        archived: false,
        sourcePath: plugin.sourcePath,
        archiveDir: null,
        files: 0,
        bytes: 0,
        hash: null,
        // 插件自己声明的第三方运行时依赖。还原脚本据此决定走 link:（离线，
        // 无依赖才能这么干）还是保留原始 npm/github 规格（让 pnpm 装齐依赖）。
        runtimeDeps: plugin.runtimeDeps ?? [],
        note: null,
      };
      if (!plugin.sourcePath) {
        record.note = '本机未找到实体文件，还原时需要用清单里的 spec 重新安装';
        pluginRecords.push(record);
        continue;
      }
      const dir = safePluginDir(plugin.name);
      const files = await collectDirectory(plugin.sourcePath, {
        prefix: `plugins/${dir}`,
        exclude: defaultExclude,
      });
      entries.push(...files);
      record.archived = true;
      record.archiveDir = `plugins/${dir}`;
      record.files = files.length;
      record.bytes = plugin.sizeBytes;
      record.hash = await hashTree(plugin.sourcePath);
      pluginRecords.push(record);
      onProgress({ phase: 'plugins', done: pluginRecords.length, total: plugins.length, name: plugin.name });
    }
  }

  // --- 技能 -----------------------------------------------------------------
  if (includeSkills) {
    for (const skill of skills) {
      const record = {
        name: skill.name,
        kind: skill.kind,
        declaredName: skill.declaredName,
        description: skill.description,
        archiveDir: null,
        files: 0,
        hash: null,
      };
      if (skill.kind === 'file') {
        entries.push({ name: `skills/${skill.name}.md`, path: skill.path });
        record.archiveDir = `skills/${skill.name}.md`;
        record.files = 1;
        record.hash = await hashFile(skill.path);
      } else {
        const files = await collectDirectory(skill.path, {
          prefix: `skills/${skill.name}`,
          exclude: defaultExclude,
        });
        entries.push(...files);
        record.archiveDir = `skills/${skill.name}`;
        record.files = files.length;
        record.hash = await hashTree(skill.path);
      }
      skillRecords.push(record);
      onProgress({ phase: 'skills', done: skillRecords.length, total: skills.length, name: skill.name });
    }
  }

  // --- 技能目录里的散件脚本（用户可能放在技能根的工具脚本） -------------------
  if (includeSkills && existsSync(skillsDir)) {
    const extras = ['setup-new-machine.ps1', 'restore-from-gist.mjs', '.gitignore'];
    for (const name of extras) {
      const abs = path.join(skillsDir, name);
      if (existsSync(abs) && (await stat(abs)).isFile()) {
        entries.push({ name: `skills/${name}`, path: abs });
      }
    }
    // 技能根下的普通文档目录（例如 docs/）也一并带走，但它们不是技能。
    for (const extraDir of await readdir(skillsDir, { withFileTypes: true })) {
      if (!extraDir.isDirectory() || extraDir.name.startsWith('.')) continue;
      if (extraDir.name === 'docs') {
        const files = await collectDirectory(path.join(skillsDir, extraDir.name), {
          prefix: `skills/${extraDir.name}`,
          exclude: defaultExclude,
        });
        entries.push(...files);
      }
    }
  }

  const manifest = {
    schema: 'dsh-backup/v1',
    generatedAt: new Date().toISOString(),
    generator: 'dsh-backup-xunlei',
    cloudFolder,
    machine: {
      hostname: os.hostname(),
      platform: `${os.platform()}-${os.arch()}`,
      user: os.userInfo().username,
      node: process.version,
    },
    dsh: { home: dshHome, profile: profileName },
    counts: {
      plugins: pluginRecords.length,
      pluginsArchived: pluginRecords.filter((row) => row.archived).length,
      skills: skillRecords.length,
    },
    plugins: pluginRecords,
    skills: skillRecords,
  };

  const readme = renderReadme(manifest);
  entries.unshift({ name: 'README.md', data: readme });
  entries.unshift({ name: '一键安装.cmd', data: renderInstallCmd(true) });
  entries.unshift({ name: 'install.cmd', data: renderInstallCmd(false) });
  entries.unshift({ name: 'restore.ps1', data: renderRestoreScript() });
  entries.unshift({ name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` });

  onProgress({ phase: 'zip', done: 0, total: entries.length, name: path.basename(outPath) });
  const written = await writeZip(entries, outPath, {
    onProgress: (done, total, name) => onProgress({ phase: 'zip', done, total, name }),
  });
  onProgress({ phase: 'done', done: entries.length, total: entries.length });

  return { manifest, zipPath: outPath, entries: written.entries, bytes: written.compressedBytes };
}

/** 生成人读的还原说明，内容随本次备份的实际构成变化。 */
function renderReadme(manifest) {
  const archived = manifest.plugins.filter((row) => row.archived);
  const missing = manifest.plugins.filter((row) => !row.archived);
  const lines = [];
  lines.push('# DSH 插件与技能备份包');
  lines.push('');
  lines.push(`- 生成时间：${manifest.generatedAt}`);
  lines.push(`- 来源机器：${manifest.machine.hostname}（${manifest.machine.platform}）`);
  lines.push(`- 来源 profile：${manifest.dsh.profile}`);
  lines.push(`- 插件 ${manifest.counts.pluginsArchived}/${manifest.counts.plugins} 个已含实体文件，技能 ${manifest.counts.skills} 个`);
  lines.push(`- 归档位置：迅雷网盘 / ${manifest.cloudFolder}`);
  lines.push('');
  lines.push('## 包里有什么');
  lines.push('');
  lines.push('| 路径 | 内容 |');
  lines.push('|---|---|');
  lines.push('| `一键安装.cmd` / `install.cmd` | **双击这个**：调用 restore.ps1 -Install 把一切装好 |');
  lines.push('| `restore.ps1` | 还原脚本本体（可单独带参数运行） |');
  lines.push('| `manifest.json` | 机器可读清单：每个插件/技能的版本、来源 spec、内容指纹 |');
  lines.push('| `profile/` | profile 的 `package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-lock.yaml` |');
  lines.push('| `plugins/` | 第三方插件的完整源码（可直接离线使用） |');
  lines.push('| `skills/` | `~/.dsh/skills` 的全部内容 |');
  lines.push('');
  lines.push('## 在新电脑上安装（双击即可）');
  lines.push('');
  lines.push('```');
  lines.push('1. 解压本包到任意目录');
  lines.push('2. 双击  一键安装.cmd');
  lines.push('3. 装完后启动 DeepSeek Harness');
  lines.push('```');
  lines.push('');
  lines.push('`一键安装.cmd` 做的就是调用 `restore.ps1 -Install`：还原技能与插件源码、');
  lines.push('合并 profile 配置、装齐依赖，最后提示你启动 DSH。命令行等价写法：');
  lines.push('');
  lines.push('```powershell');
  lines.push('powershell -ExecutionPolicy Bypass -File restore.ps1 -Install');
  lines.push('```');
  lines.push('');
  lines.push('技能放到 `~/.dsh/skills` 后**热生效，无需重启**；插件与新 profile 需要 DSH 启动后加载。');
  lines.push('');
  lines.push('> 包内文件名说明：`一键安装.cmd` 是中文入口，转发到内容全 ASCII 的 `install.cmd`。');
  lines.push('> 批处理里的中文在非中文区域设置下必然乱码，所以所有中文提示都交给带 BOM 的');
  lines.push('> `restore.ps1` 打印——即便如此，某些解压工具仍可能弄乱中文文件名，此时双击');
  lines.push('> `install.cmd` 效果完全相同。');
  lines.push('');
  lines.push('### 依赖是怎么处理的');
  lines.push('');
  lines.push('- 备份包里有实体文件的插件，默认被改写成本机 `link:`，**不需要联网**。');
  lines.push('- 例外：插件自己声明了第三方运行时依赖，而备份包里不含 `node_modules`，');
  lines.push('  这类会保留原始 npm/GitHub 规格交由 pnpm 安装（否则 `require` 会失败）。');
  lines.push('- 内置的 `@deepseek-ai/*` bundle 随 DSH 发行，不需要备份也不参与还原。');
  lines.push('');
  lines.push('## 本次包含的插件');
  lines.push('');
  lines.push('| 插件 | 版本 | 来源 | 实体文件 |');
  lines.push('|---|---|---|---|');
  for (const row of archived) {
    lines.push(`| \`${row.name}\` | ${row.version ?? '-'} | \`${row.spec}\` | ✅ ${row.files} 个文件 |`);
  }
  for (const row of missing) {
    lines.push(`| \`${row.name}\` | ${row.version ?? '-'} | \`${row.spec}\` | ⚠️ 未打包，需联网重装 |`);
  }
  lines.push('');
  lines.push('## 本次包含的技能');
  lines.push('');
  lines.push('| 技能 | 说明 |');
  lines.push('|---|---|');
  for (const row of manifest.skills) {
    lines.push(`| \`${row.name}\` | ${(row.description || '').replace(/\|/g, '\\|') || '-'} |`);
  }
  lines.push('');
  if (missing.length > 0) {
    lines.push('> 上面标 ⚠️ 的插件在本机没有找到实体文件，还原时需要能访问 npm / GitHub。');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** 还原脚本：拷回技能、插件源码与 profile 配置，并把 link: 依赖改写成本机路径。 */
function renderRestoreScript() {
  // 开头的 U+FEFF 是给 Windows PowerShell 5.1 看的：它默认按 ANSI 读取无 BOM 的
  // .ps1，脚本里的中文会被解错、甚至吃掉引号导致整个脚本语法错误。
  //
  // 本函数里的字符串会原样写进 restore.ps1，所以要注意 JS 模板字面量会吃掉反斜杠
  // （'skills\\*' 会变成 'skills*'）。路径一律用 Join-Path 拼，不写字面反斜杠。
  return `\uFEFF#Requires -Version 5.1
<#
.SYNOPSIS
    从本备份包一键还原 DeepSeek Harness 的插件与技能。

.DESCRIPTION
    做的四件事：
      1. 技能     -> <DSH_HOME>/skills（DSH 只扫描根目录下一层，位置必须准确）
      2. 插件源码 -> <DSH_HOME>/restored-plugins/<包名>
      3. profile  -> 与目标机已有的 package.json 合并（依赖 + bundle 取并集，不覆盖）
      4. 依赖     -> 有 pnpm 就跑 pnpm install；没有就用目录联接把 link: 依赖直接接上

    最省事的用法是双击包里的「一键安装.cmd」，它会带着 -Install 调用本脚本。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File restore.ps1 -Install
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File restore.ps1 -DshHome "D:\\.dsh" -Profile web
#>
[CmdletBinding()]
param(
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
    [string]$Profile = '',
    [string]$PluginsDir = '',
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }

$manifestPath = Join-Path $root 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw '找不到 manifest.json，请在解压后的包根目录运行本脚本。' }
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  DeepSeek Harness 插件与技能 一键还原' -ForegroundColor Cyan
Write-Host "  备份时间 $($manifest.generatedAt)  来源 $($manifest.machine.hostname)" -ForegroundColor DarkGray
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

# --- 0. 定位 DSH_HOME 与 profile -------------------------------------------
if (-not (Test-Path $DshHome)) { New-Item -ItemType Directory -Force -Path $DshHome | Out-Null }
$profilesRoot = Join-Path $DshHome 'profiles'

# profile 名优先按目标机实际存在的来：新机器上用户可能不是 desktop。
$existingProfiles = @()
if (Test-Path $profilesRoot) {
    $existingProfiles = @(Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'package.json') })
}
$profileCreated = $false
if (-not $Profile) {
    $named = $existingProfiles | Where-Object { $_.Name -eq $manifest.dsh.profile }
    if ($named) { $Profile = $named.Name }
    elseif ($existingProfiles.Count -eq 1) { $Profile = $existingProfiles[0].Name }
    elseif ($existingProfiles.Count -gt 1) {
        $Profile = ($existingProfiles | Sort-Object LastWriteTime -Descending)[0].Name
    }
    else {
        # 这台机器还没启动过 DSH。直接按备份包把 profile 建出来，启动即可用。
        $Profile = $manifest.dsh.profile
        $profileCreated = $true
    }
}

$profileDir = Join-Path $profilesRoot $Profile
$skillsDir  = Join-Path $DshHome 'skills'
if (-not $PluginsDir) { $PluginsDir = Join-Path $DshHome 'restored-plugins' }

Step "DSH_HOME   = $DshHome"
Step "profile    = $Profile"
Step "技能目录   = $skillsDir"
Step "插件源码   = $PluginsDir"
if ($profileCreated) {
    Write-Host ''
    Warn '这台电脑上还没检测到 DeepSeek Harness 的 profile。'
    Warn "将直接按备份包创建 $profileDir —— 装好后启动 DSH 即可使用。"
    Warn '（如果启动异常：删掉该 profile 目录，先启动一次 DSH 让它生成空 profile，再重跑本脚本。）'
}
Write-Host ''

# --- 1. 技能 ---------------------------------------------------------------
if (Test-Path (Join-Path $root 'skills')) {
    Step '还原技能'
    New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
    # 刻意用 Join-Path 拼 '*'，不写 'skills\\*'——反斜杠在模板里会被吃掉，那样会
    # 匹配到 skills 目录本身，多套一层 skills\\skills\\ ，而 DSH 只扫一层，技能全发现不了。
    $skillsSrc = Join-Path $root 'skills'
    Copy-Item -Path (Join-Path $skillsSrc '*') -Destination $skillsDir -Recurse -Force
    $found = @(Get-ChildItem $skillsDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'SKILL.md') })
    Ok "技能目录：$(@(Get-ChildItem $skillsDir -Recurse -File -ErrorAction SilentlyContinue).Count) 个文件，可识别技能 $($found.Count) 个（$((@($found | ForEach-Object { $_.Name })) -join '、')）"
}

# --- 2. 插件源码 -----------------------------------------------------------
$linkMap = @{}
if (Test-Path (Join-Path $root 'plugins')) {
    Step '还原插件源码'
    New-Item -ItemType Directory -Force -Path $PluginsDir | Out-Null
    foreach ($row in $manifest.plugins) {
        if (-not $row.archived) { continue }
        $safe = $row.name -replace '/', '__'
        $src = Join-Path $root ($row.archiveDir -replace '/', '\\')
        $dst = Join-Path $PluginsDir $safe
        if (Test-Path $src) {
            if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
            Copy-Item -Path $src -Destination $dst -Recurse -Force
            $linkMap[$row.name] = $dst
        }
    }
    Ok "$($linkMap.Count) 个插件的源码已就位"
}

# --- 3. profile 配置与 package.json ----------------------------------------
if (Test-Path (Join-Path $root 'profile')) {
    Step '合并 profile 配置'
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
    foreach ($f in 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml') {
        $src = Join-Path $root (Join-Path 'profile' $f)
        if (-not (Test-Path $src)) { continue }
        $dstFile = Join-Path $profileDir $f
        if (Test-Path $dstFile) {
            $stamp = Get-Date -Format 'yyyyMMddHHmmss'
            Copy-Item $dstFile "$dstFile.bak-$stamp" -Force -ErrorAction SilentlyContinue
        }
        Copy-Item $src $dstFile -Force
    }
    Ok '配置文件已恢复（原有同名文件已留成 .bak-时间戳）'

    $backupPkg = Get-Content (Join-Path $root (Join-Path 'profile' 'package.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
    $targetPkgPath = Join-Path $profileDir 'package.json'
    $targetPkg = if (Test-Path $targetPkgPath) { Get-Content $targetPkgPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $backupPkg }

    # 依赖策略：能离线就离线，不能就别硬来。
    #   原本就是 link:/file: 的（工作区里的自研插件）→ 必须指回本机还原出来的源码；
    #   原本来自 npm/GitHub 且自己没有第三方运行时依赖  → 也走 link:，无需联网；
    #   原本来自 npm/GitHub 但有运行时依赖（包里不含 node_modules）→ 保留原始规格，
    #   交给 pnpm 装齐依赖，否则 require 会直接失败。
    $fromRegistry = @()
    foreach ($row in $manifest.plugins) {
        if (-not $linkMap.ContainsKey($row.name)) { continue }
        $spec = "$($backupPkg.dependencies.($row.name))"
        $originallyLocal = $spec.StartsWith('link:') -or $spec.StartsWith('file:')
        $hasDeps = @($row.runtimeDeps).Count -gt 0
        if ($originallyLocal -or -not $hasDeps) { continue }
        $linkMap.Remove($row.name)
        $fromRegistry += "$($row.name)（需要 $((@($row.runtimeDeps)) -join ', ')）"
    }

    $linkedNames = @()
    foreach ($row in $backupPkg.dependencies.PSObject.Properties) {
        $name = $row.Name
        $value = $row.Value
        if ($linkMap.ContainsKey($name)) {
            $value = 'link:' + ($linkMap[$name] -replace '\\\\', '/')
            $linkedNames += $name
        }
        if ($targetPkg.dependencies.PSObject.Properties.Name -contains $name) {
            $targetPkg.dependencies.$name = $value
        } else {
            $targetPkg.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue $value
        }
    }
    Ok "$($linkedNames.Count) 个插件指向本机还原出来的源码（离线可用）"
    if ($fromRegistry.Count -gt 0) {
        Warn "$($fromRegistry.Count) 个插件自带第三方依赖，保留原规格由 pnpm 安装："
        foreach ($r in $fromRegistry) { Warn "  - $r" }
    }

    # bundle 列表取「目标机已有」与「备份里」的并集，避免抹掉新机器自己的 bundle。
    $bundles = New-Object System.Collections.Generic.List[string]
    if ($targetPkg.dsh -and $targetPkg.dsh.profile -and $targetPkg.dsh.profile.bundles) {
        foreach ($b in @($targetPkg.dsh.profile.bundles)) { if (-not $bundles.Contains($b)) { $bundles.Add($b) } }
    }
    if ($backupPkg.dsh -and $backupPkg.dsh.profile -and $backupPkg.dsh.profile.bundles) {
        foreach ($b in @($backupPkg.dsh.profile.bundles)) { if (-not $bundles.Contains($b)) { $bundles.Add($b) } }
    }
    if (-not $targetPkg.dsh) { $targetPkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
    $profileNode = [pscustomobject]@{ bundles = @($bundles); patchReload = 'live' }
    if ($targetPkg.dsh.PSObject.Properties.Name -contains 'profile') { $targetPkg.dsh.profile = $profileNode }
    else { $targetPkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue $profileNode }

    [System.IO.File]::WriteAllText($targetPkgPath, ($targetPkg | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
    Ok "package.json 已合并：$($bundles.Count) 个 bundle"

    $script:linkedPluginNames = $linkedNames
}

# --- 4. 装依赖：pnpm 优先，目录联接兜底 -------------------------------------
function Resolve-Pnpm {
    $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($cmd) { return @{ node = $null; pnpm = $cmd.Source } }

    # DSH 自带一份 pnpm 运行时，两个可能的落点都试一下。
    $pnpmRoots = @(
        (Join-Path $env:LOCALAPPDATA (Join-Path 'Programs' (Join-Path 'DeepSeek Harness' (Join-Path 'resources' (Join-Path 'runtime' (Join-Path 'primary-runtime' (Join-Path 'dependencies' 'pnpm'))))))),
        (Join-Path $DshHome (Join-Path 'dsh-runtimes' (Join-Path 'dsh-primary-runtime' (Join-Path 'dependencies' 'pnpm'))))
    )
    foreach ($pnpmRoot in $pnpmRoots) {
        $cjs = Join-Path $pnpmRoot (Join-Path 'bin' 'pnpm.cjs')
        if (-not (Test-Path $cjs)) { continue }
        $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $nodeExe) {
            $nodeGuess = Join-Path (Split-Path $pnpmRoot -Parent) (Join-Path 'node' (Join-Path 'bin' 'node.exe'))
            if (Test-Path $nodeGuess) { $nodeExe = $nodeGuess }
        }
        return @{ node = $nodeExe; pnpm = $cjs }
    }
    return $null
}

function New-DirLink {
    param([string]$Link, [string]$Target)
    $parent = Split-Path -Parent $Link
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    if (Test-Path $Link) { return $true }
    try {
        New-Item -ItemType Junction -Path $Link -Target $Target -ErrorAction Stop | Out-Null
        return $true
    } catch { }
    try {
        & cmd.exe /c mklink /J "$Link" "$Target" | Out-Null
        return (Test-Path $Link)
    } catch { return $false }
}

$pnpmInfo = Resolve-Pnpm
$installOk = $false
if ($Install) {
    Step '安装依赖'
    if ($pnpmInfo) {
        Push-Location $profileDir
        try {
            if ($pnpmInfo.pnpm.EndsWith('.cjs')) {
                if (-not $pnpmInfo.node) { Warn '找到了 pnpm 但找不到 node，跳过 pnpm install'; }
                else { & $pnpmInfo.node $pnpmInfo.pnpm install; $installOk = ($LASTEXITCODE -eq 0) }
            } else {
                & $pnpmInfo.pnpm install
                $installOk = ($LASTEXITCODE -eq 0)
            }
        } catch {
            Warn "pnpm install 出错：$($_.Exception.Message)"
        } finally { Pop-Location }
        if ($installOk) { Ok 'pnpm install 完成' } else { Warn 'pnpm install 未成功，改用目录联接兜底' }
    } else {
        Warn '这台电脑上找不到 pnpm，改用目录联接兜底'
    }
}

# 兜底（也顺带补齐 pnpm 可能漏掉的 link: 项）：把每个 link: 依赖直接接成目录联接。
if ($script:linkedPluginNames -and $script:linkedPluginNames.Count -gt 0) {
    $nodeModules = Join-Path $profileDir 'node_modules'
    $made = 0
    $failed = @()
    foreach ($name in $script:linkedPluginNames) {
        $link = Join-Path $nodeModules ($name -replace '/', '\\')
        if (Test-Path $link) { continue }
        $target = $linkMap[$name]
        if (-not $target) { continue }
        if (New-DirLink -Link $link -Target $target) { $made++ } else { $failed += $name }
    }
    if ($made -gt 0) { Ok "补齐 $made 个目录联接" }
    if ($failed.Count -gt 0) {
        Warn "有 $($failed.Count) 个插件没能接上：$($failed -join '、')"
        Warn '如果 DSH 里看不到它们，请在 profile 目录手动执行一次 pnpm install。'
    }
}

# --- 5. 结果 ---------------------------------------------------------------
Write-Host ''
Step '完成'
Write-Host '    下一步：启动 DeepSeek Harness。' -ForegroundColor Green
Write-Host '    - 技能是热生效的，插件与新 profile 需要 DSH 启动后才会加载。' -ForegroundColor Gray
if ($profileCreated) {
    Write-Host '    - 这是首次安装，启动 DSH 时会按上面合并好的 package.json 加载插件。' -ForegroundColor Gray
}
Write-Host ''
Write-Host "    技能：$skillsDir" -ForegroundColor DarkGray
Write-Host "    插件：$PluginsDir" -ForegroundColor DarkGray
Write-Host "    profile：$profileDir" -ForegroundColor DarkGray
Write-Host ''
`;
}

/**
 * 生成包根目录的安装脚本。
 *
 * 两个 .cmd 都刻意写成纯 ASCII：cmd.exe 按当前代码页解释批处理文件，里面写中文
 * 在非中文区域设置下必然乱码；所有中文提示都交给带 BOM 的 restore.ps1 去打印。
 * 中文文件名只是给用户看的入口，「一键安装.cmd」转发到 ASCII 名的 install.cmd，
 * 这样即使某些解压工具把中文名弄乱，用户也还有可用的那个。
 */
function renderInstallCmd(forwarder) {
  if (forwarder) {
    return [
      '@echo off',
      'rem 中文名入口：转发到 install.cmd（内容全部是 ASCII，避免代码页问题）',
      'call "%~dp0install.cmd" %*',
      '',
    ].join('\r\n');
  }
  return [
    '@echo off',
    'setlocal',
    'title DeepSeek Harness - one-click restore',
    'cd /d "%~dp0"',
    '',
    'echo.',
    'echo   DeepSeek Harness plugin ^& skill restore',
    'echo   ------------------------------------------------',
    'echo.',
    '',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore.ps1" -Install %*',
    'set "RC=%ERRORLEVEL%"',
    '',
    'echo.',
    'if "%RC%"=="0" (',
    '  echo   [OK] Restore finished. Now start DeepSeek Harness.',
    ') else (',
    '  echo   [!] Restore exited with code %RC%. See the messages above.',
    ')',
    'echo.',
    'pause',
    '',
  ].join('\r\n');
}
