/**
 * 备份状态与差异检测。
 *
 * 「一键上传当前设备上**新的**插件和技能」这句需求里的「新的」需要一个基准：
 * 每次备份成功后把当时的插件/技能指纹写进 state.json，下一次盘点时比对，
 * 就能明确说出「新增了哪几个、哪几个有改动」。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const STATE_SCHEMA = 'dsh-backup-xunlei/state/v1';

export function stateDir(dshHome) {
  return path.join(dshHome, 'backup-xunlei');
}

export function statePath(dshHome) {
  return path.join(stateDir(dshHome), 'state.json');
}

export function archiveDir(dshHome, sub = 'out') {
  return path.join(stateDir(dshHome), sub);
}

export const EMPTY_STATE = Object.freeze({
  schema: STATE_SCHEMA,
  lastBackupAt: null,
  lastArchive: null,
  plugins: {},
  skills: {},
  history: [],
});

export async function loadState(dshHome) {
  try {
    const raw = await readFile(statePath(dshHome), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.schema !== STATE_SCHEMA) return { ...EMPTY_STATE };
    return {
      ...EMPTY_STATE,
      ...parsed,
      plugins: parsed.plugins ?? {},
      skills: parsed.skills ?? {},
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export async function saveState(dshHome, state) {
  const dir = stateDir(dshHome);
  await mkdir(dir, { recursive: true });
  await writeFile(statePath(dshHome), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return statePath(dshHome);
}

/**
 * 与上次备份比对。
 *
 * @param {Array} currentPlugins listPlugins() 的结果
 * @param {Array} currentSkills  listSkills() 的结果
 * @param {object} state         loadState() 的结果
 */
export function diffAgainstState(currentPlugins, currentSkills, state) {
  const pluginRows = currentPlugins.map((plugin) => {
    const previous = state.plugins?.[plugin.name];
    let status = 'unchanged';
    if (!previous) status = 'added';
    else if (previous.version !== plugin.version || previous.hash !== plugin.hashForCompare) status = 'updated';
    return { name: plugin.name, version: plugin.version, status, previousVersion: previous?.version ?? null };
  });

  const skillRows = currentSkills.map((skill) => {
    const previous = state.skills?.[skill.name];
    let status = 'unchanged';
    if (!previous) status = 'added';
    else if (previous.hash !== skill.hashForCompare) status = 'updated';
    return { name: skill.name, status };
  });

  const removedPlugins = Object.keys(state.plugins ?? {}).filter(
    (name) => !currentPlugins.some((plugin) => plugin.name === name),
  );
  const removedSkills = Object.keys(state.skills ?? {}).filter(
    (name) => !currentSkills.some((skill) => skill.name === name),
  );

  const summarise = (rows) => ({
    added: rows.filter((row) => row.status === 'added').map((row) => row.name),
    updated: rows.filter((row) => row.status === 'updated').map((row) => row.name),
    unchanged: rows.filter((row) => row.status === 'unchanged').map((row) => row.name),
  });

  const plugins = summarise(pluginRows);
  const skills = summarise(skillRows);

  return {
    firstRun: state.lastBackupAt === null,
    hasChanges:
      plugins.added.length + plugins.updated.length + skills.added.length + skills.updated.length > 0,
    plugins,
    skills,
    removedPlugins,
    removedSkills,
    totalChanges:
      plugins.added.length +
      plugins.updated.length +
      skills.added.length +
      skills.updated.length +
      removedPlugins.length +
      removedSkills.length,
  };
}

/** 用本次备份的指纹推进状态。 */
export function advanceState(state, manifest, upload) {
  const plugins = {};
  for (const row of manifest.plugins) {
    if (!row.hash) continue;
    plugins[row.name] = { version: row.version, hash: row.hash, spec: row.spec };
  }
  const skills = {};
  for (const row of manifest.skills) {
    if (!row.hash) continue;
    skills[row.name] = { hash: row.hash, kind: row.kind };
  }
  const entry = {
    at: manifest.generatedAt,
    archive: path.basename(upload?.archive ?? ''),
    archivePath: upload?.archive ?? null,
    zipBytes: upload?.zipBytes ?? null,
    cloudFolder: manifest.cloudFolder,
    plugins: manifest.counts.pluginsArchived,
    skills: manifest.counts.skills,
    uploadStatus: upload?.status ?? 'unknown',
    uploadMessage: upload?.message ?? null,
  };
  return {
    schema: STATE_SCHEMA,
    lastBackupAt: manifest.generatedAt,
    lastArchive: entry.archive,
    plugins,
    skills,
    history: [entry, ...(state.history ?? [])].slice(0, 20),
  };
}
