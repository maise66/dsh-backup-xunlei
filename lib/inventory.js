/**
 * 本机资产盘点：找出这个 profile 装了哪些第三方插件、装了哪些技能。
 *
 * 关键事实（来自 dshmarket 的 backup.js 与 @deepseek-ai/dsh-skill-filesystem）：
 * - 插件清单在 `$DSH_HOME/profiles/<profile>/package.json`，第三方插件的实体在
 *   同目录的 `node_modules/<包名>`；`link:` / `file:` 依赖指向工作区源码目录。
 * - 技能在 `$DSH_HOME/skills`，DSH 只扫描该目录的下一层：`<名称>/SKILL.md`
 *   或根目录扁平的 `<名称>.md`。
 * - `@deepseek-ai/*` 是随 DSH 发行的内置 bundle，不需要备份。
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 随 DSH 发行的内置包前缀，不纳入备份。 */
export const BUILTIN_PREFIX = '@deepseek-ai/';

/** 探测 DSH_HOME。 */
export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 探测当前 profile 目录（优先环境变量，其次取唯一带 package.json 的 profile）。 */
export async function resolveProfileDir(dshHome = resolveDshHome()) {
  const explicit = process.env.DSH_PROFILE;
  const profilesRoot = path.join(dshHome, 'profiles');
  if (explicit) {
    const dir = path.join(profilesRoot, explicit);
    if (existsSync(path.join(dir, 'package.json'))) return dir;
  }
  if (!existsSync(profilesRoot)) throw new Error(`找不到 DSH profiles 目录：${profilesRoot}`);
  const entries = await readdir(profilesRoot, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(profilesRoot, entry.name);
    if (existsSync(path.join(dir, 'package.json'))) candidates.push(dir);
  }
  if (candidates.length === 0) throw new Error(`在 ${profilesRoot} 下找不到任何带 package.json 的 profile`);
  // 有多个时优先 desktop，其次取最近修改的。
  const desktop = candidates.find((dir) => path.basename(dir) === 'desktop');
  if (desktop) return desktop;
  let best = candidates[0];
  let bestTime = 0;
  for (const dir of candidates) {
    const info = await stat(path.join(dir, 'package.json'));
    if (info.mtimeMs > bestTime) {
      bestTime = info.mtimeMs;
      best = dir;
    }
  }
  return best;
}

/** 读出 profile 的 package.json。 */
export async function readProfilePackage(profileDir) {
  const file = path.join(profileDir, 'package.json');
  const raw = await readFile(file, 'utf8');
  return { file, json: JSON.parse(raw) };
}

/** 把依赖说明符分类：npm 版本、github:、link:/file: 本地目录。 */
export function classifySpec(name, spec) {
  const value = String(spec ?? '').trim();
  if (value.startsWith('link:') || value.startsWith('file:')) {
    return { kind: 'local', target: value.slice(value.indexOf(':') + 1) };
  }
  if (value.startsWith('github:') || value.startsWith('git+') || value.includes('github.com')) {
    return { kind: 'github', target: value };
  }
  return { kind: 'npm', target: value };
}

/** 解析 pnpm 的 node_modules 位置：profile 本地优先，其次 profiles 根的提升目录。 */
export function resolveInstalledDir(profileDir, name) {
  const local = path.join(profileDir, 'node_modules', ...name.split('/'));
  if (existsSync(path.join(local, 'package.json'))) return local;
  const hoisted = path.join(path.dirname(profileDir), 'node_modules', ...name.split('/'));
  if (existsSync(path.join(hoisted, 'package.json'))) return hoisted;
  return null;
}

/** 解析 link:/file: 指向的真实目录（相对路径按 profile 目录解析）。 */
export function resolveLocalDir(profileDir, target) {
  const raw = String(target).replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(raw)) return path.normalize(raw);
  return path.resolve(profileDir, raw);
}

async function readJsonSafe(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 列出要备份的第三方插件。
 *
 * @returns {Promise<Array<{name:string,spec:string,kind:string,sourcePath:string|null,
 *   version:string|null,enabled:boolean,present:boolean,sizeBytes:number}>>}
 */
export async function listPlugins(profileDir) {
  const { json } = await readProfilePackage(profileDir);
  const dependencies = json.dependencies ?? {};
  const bundles = new Set(json.dsh?.profile?.bundles ?? []);
  const out = [];

  for (const [name, spec] of Object.entries(dependencies)) {
    if (name.startsWith(BUILTIN_PREFIX)) continue;
    const { kind, target } = classifySpec(name, spec);
    let sourcePath = null;
    let version = null;
    let runtimeDeps = [];

    if (kind === 'local') {
      const dir = resolveLocalDir(profileDir, target);
      if (existsSync(dir)) {
        sourcePath = dir;
        const pkg = await readJsonSafe(path.join(dir, 'package.json'));
        version = pkg?.version ?? null;
        runtimeDeps = Object.keys(pkg?.dependencies ?? {});
      }
    } else {
      const dir = resolveInstalledDir(profileDir, name);
      if (dir) {
        sourcePath = dir;
        const pkg = await readJsonSafe(path.join(dir, 'package.json'));
        version = pkg?.version ?? null;
        runtimeDeps = Object.keys(pkg?.dependencies ?? {});
      }
    }

    out.push({
      name,
      spec: String(spec),
      kind,
      target,
      sourcePath,
      version,
      runtimeDeps,
      present: sourcePath !== null,
      enabled: bundles.size === 0 ? true : bundles.has(name),
      sizeBytes: sourcePath ? await directorySize(sourcePath) : 0,
    });
  }

  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** 列出技能：目录包 `<名称>/SKILL.md` 与根目录扁平 `<名称>.md`。 */
export async function listSkills(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      const meta = parseSkillFrontmatter(await readFile(skillFile, 'utf8'));
      out.push({
        name: entry.name,
        kind: 'directory',
        path: path.join(skillsDir, entry.name),
        description: meta.description ?? '',
        declaredName: meta.name ?? null,
        sizeBytes: await directorySize(path.join(skillsDir, entry.name)),
      });
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const file = path.join(skillsDir, entry.name);
      const meta = parseSkillFrontmatter(await readFile(file, 'utf8'));
      if (!meta.name) continue; // 扁平文件必须有 name 才会被 DSH 识别
      out.push({
        name: entry.name.replace(/\.md$/i, ''),
        kind: 'file',
        path: file,
        description: meta.description ?? '',
        declaredName: meta.name,
        sizeBytes: (await stat(file)).size,
      });
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** 极简 frontmatter 解析：只取顶层 `key: value`，够用且不引入 yaml 依赖。 */
export function parseSkillFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[kv[1]] = value;
  }
  return out;
}

async function directorySize(dir) {
  let total = 0;
  const walk = async (current) => {
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name === '.git' || item.name === 'node_modules') continue;
      const abs = path.join(current, item.name);
      if (item.isDirectory()) await walk(abs);
      else if (item.isFile()) {
        try {
          total += (await stat(abs)).size;
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  await walk(dir);
  return total;
}

/** 目录内容指纹（相对路径 + 文件 SHA-256），用于识别新增/改动。 */
export async function hashTree(root) {
  const hash = createHash('sha256');
  const walk = async (current, rel) => {
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      if (item.name === '.git' || item.name === 'node_modules') continue;
      const abs = path.join(current, item.name);
      const relPath = rel === '' ? item.name : `${rel}/${item.name}`;
      if (item.isDirectory()) {
        await walk(abs, relPath);
      } else if (item.isFile()) {
        hash.update(`${relPath}\u0000`);
        hash.update(await readFile(abs));
        hash.update('\u0000');
      }
    }
  };
  await walk(root, '');
  return hash.digest('hex');
}

/** 单文件指纹。 */
export async function hashFile(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
