/**
 * 编排层：把「盘点 → 打包 → 上传 → 记账」串成一个可复用的动作。
 *
 * host.js 的三个入口（设置面板按钮、`/backup-xunlei` 命令、`backup_xunlei` 工具）
 * 都调用这里的同一个实现，保证行为一致。
 */

import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { listPlugins, listSkills, resolveDshHome, resolveProfileDir, hashTree, hashFile } from './inventory.js';
import { buildArchive } from './packer.js';
import { advanceState, archiveDir, diffAgainstState, loadState, saveState } from './state.js';
import { discoverLocalPan, findThunder, quota, uploadArchive } from './xunlei.js';

/** 时间戳后缀：20261010-154512（本地时间，便于和云盘里的文件对得上）。 */
export function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 盘点本机资产，并算出相对上次备份的差异。 */
export async function scanAssets(options = {}) {
  const dshHome = options.dshHome ?? resolveDshHome();
  const profileDir = options.profileDir ?? (await resolveProfileDir(dshHome));
  const includePlugins = options.includePlugins !== false;
  const includeSkills = options.includeSkills !== false;

  const [plugins, skills, state] = await Promise.all([
    includePlugins ? listPlugins(profileDir) : Promise.resolve([]),
    includeSkills ? listSkills(path.join(dshHome, 'skills')) : Promise.resolve([]),
    loadState(dshHome),
  ]);

  if (includePlugins) {
    for (const plugin of plugins) {
      plugin.hashForCompare = plugin.sourcePath ? await hashTree(plugin.sourcePath) : null;
    }
  }
  if (includeSkills) {
    for (const skill of skills) {
      skill.hashForCompare =
        skill.kind === 'file' ? await hashFile(skill.path) : await hashTree(skill.path);
    }
  }

  const diff = diffAgainstState(plugins, skills, state);

  return {
    dshHome,
    profileDir,
    profileName: path.basename(profileDir),
    plugins,
    skills,
    state,
    diff,
    totals: {
      plugins: plugins.length,
      pluginsPresent: plugins.filter((plugin) => plugin.present).length,
      skills: skills.length,
      pluginBytes: plugins.reduce((sum, plugin) => sum + (plugin.sizeBytes ?? 0), 0),
      skillBytes: skills.reduce((sum, skill) => sum + (skill.sizeBytes ?? 0), 0),
    },
  };
}

/** 本地保留最近 n 个备份包（0 表示全部保留）。 */
async function pruneArchives(dshHome, keep) {
  if (!keep || keep <= 0) return [];
  const dir = archiveDir(dshHome, 'out');
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const zips = [];
  for (const name of files) {
    if (!name.toLowerCase().endsWith('.zip')) continue;
    const abs = path.join(dir, name);
    try {
      zips.push({ name, abs, mtime: (await stat(abs)).mtimeMs });
    } catch {
      /* 忽略 */
    }
  }
  zips.sort((a, b) => b.mtime - a.mtime);
  const removed = [];
  for (const item of zips.slice(keep)) {
    try {
      await rm(item.abs, { force: true });
      removed.push(item.name);
    } catch {
      /* 忽略 */
    }
  }
  return removed;
}

/**
 * 跑一次完整备份。
 *
 * @param {object} [options]
 * @param {boolean} [options.upload]           是否上传到迅雷网盘（默认 true）
 * @param {boolean} [options.force]            即使没有任何变化也照样打包上传（默认 false）
 * @param {boolean} [options.onlyWhenChanged]  force 的相反语义（默认 false）
 * @param {string}  [options.cloudFolder]      云盘归档文件夹（默认 DSH-Backup）
 * @param {number}  [options.keepArchives]     本地保留几个包
 * @param {(message: string) => void} [options.log]
 */
export async function runBackup(options = {}) {
  const started = Date.now();
  const log = options.log ?? (() => {});
  const progress = [];

  log('盘点本机的插件与技能…');
  const scan = await scanAssets({
    dshHome: options.dshHome,
    profileDir: options.profileDir,
    includePlugins: options.includePlugins,
    includeSkills: options.includeSkills,
  });

  log(
    `插件 ${scan.totals.plugins} 个（含实体文件 ${scan.totals.pluginsPresent} 个）、技能 ${scan.totals.skills} 个`,
  );
  if (scan.diff.firstRun) {
    log('这是第一次备份，将建立基准。');
  } else if (scan.diff.hasChanges) {
    const describe = (label, rows) => {
      const parts = [];
      if (rows.added.length) parts.push(`新增 ${rows.added.length}（${rows.added.slice(0, 6).join('、')}${rows.added.length > 6 ? '…' : ''}）`);
      if (rows.updated.length) parts.push(`变更 ${rows.updated.length}（${rows.updated.slice(0, 6).join('、')}${rows.updated.length > 6 ? '…' : ''}）`);
      return parts.length ? `${label}：${parts.join('，')}` : null;
    };
    for (const line of [describe('插件', scan.diff.plugins), describe('技能', scan.diff.skills)]) {
      if (line) log(line);
    }
    if (scan.diff.removedPlugins.length) log(`已移除的插件：${scan.diff.removedPlugins.join('、')}`);
    if (scan.diff.removedSkills.length) log(`已移除的技能：${scan.diff.removedSkills.join('、')}`);
  } else {
    log('与上次备份相比没有变化。');
  }

  const cloudFolder = options.cloudFolder ?? 'DSH-Backup';
  const outDir = archiveDir(scan.dshHome, 'out');
  await mkdir(outDir, { recursive: true });

  const archiveName = `dsh-backup-${stamp()}.zip`;
  const archivePath = path.join(outDir, archiveName);

  log(`开始打包 → ${archiveName}`);
  const built = await buildArchive({
    dshHome: scan.dshHome,
    profileDir: scan.profileDir,
    outPath: archivePath,
    cloudFolder,
    includePlugins: options.includePlugins !== false,
    includeSkills: options.includeSkills !== false,
    onProgress: (event) => {
      progress.push(event);
      if (event.phase === 'zip' && event.done % 200 === 0) {
        log(`  打包进度 ${event.done}/${event.total}`);
      }
    },
  });
  const zipStat = await stat(archivePath);
  log(`打包完成：${built.entries} 个条目，${(zipStat.size / 1024 / 1024).toFixed(1)} MB`);

  let upload = { status: 'skipped', message: '按参数跳过了上传', archive: archivePath };
  if (options.upload !== false) {
    log(`上传到迅雷网盘「${cloudFolder}」…（会短暂占用鼠标点击一次弹窗的「确定」）`);
    upload = await uploadArchive(archivePath, {
      cloudFolder,
      log,
      verifyTimeoutMs: options.verifyTimeoutMs,
      dialogTimeoutSeconds: options.dialogTimeoutSeconds,
    });
    upload.archive = archivePath;
    upload.zipBytes = zipStat.size;
    log(upload.message);
    if (options.uploadOkOnly && upload.status !== 'verified' && upload.status !== 'submitted-unverified') {
      return { ok: false, ...upload };
    }
  }

  const nextState = advanceState(scan.state, built.manifest, { ...upload, archive: archivePath, zipBytes: zipStat.size });
  await saveState(scan.dshHome, nextState);

  const pruned = await pruneArchives(scan.dshHome, options.keepArchives ?? 5);
  if (pruned.length) log(`清理本地旧备份：${pruned.join('、')}`);

  return {
    ok: true,
    archive: archivePath,
    archiveName,
    zipBytes: zipStat.size,
    cloudFolder,
    entries: built.entries,
    manifest: built.manifest,
    scan: {
      dshHome: scan.dshHome,
      profile: scan.profileName,
      totals: scan.totals,
      diff: scan.diff,
    },
    upload,
    pruned,
    stateFile: path.join(scan.dshHome, 'backup-xunlei', 'state.json'),
    durationMs: Date.now() - started,
  };
}

/** 只做体检：迅雷是否可用、云盘接口是否可读、有没有未备份的改动。 */
export async function probeEnvironment(options = {}) {
  const dshHome = options.dshHome ?? resolveDshHome();
  let scan = null;
  let scanError = null;
  try {
    scan = await scanAssets({ dshHome, includePlugins: true, includeSkills: true });
  } catch (error) {
    scanError = error?.message ?? String(error);
  }
  const pan = await discoverLocalPan();
  const quotaInfo = pan.available ? await quota(pan) : null;
  const thunder = findThunder();
  return {
    dshHome,
    profile: scan?.profileName ?? null,
    totals: scan?.totals ?? null,
    diff: scan?.diff ?? null,
    lastBackupAt: scan?.state?.lastBackupAt ?? null,
    lastArchive: scan?.state?.lastArchive ?? null,
    history: scan?.state?.history ?? [],
    scanError,
    thunder,
    pan: { available: pan.available, port: pan.port, tokenExpiresAt: pan.expiresAt },
    quota: quotaInfo,
  };
}
