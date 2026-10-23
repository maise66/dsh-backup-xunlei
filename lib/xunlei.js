/**
 * 迅雷网盘接入层。
 *
 * 上传走迅雷自己注册的资源管理器右键动词（「上传到迅雷云盘」）：
 *
 *     Thunder.exe -ShellUpload:"<文件>" -StartType=Explorer
 *
 * **这个界面在两代迅雷里完全不同**：
 *
 *   旧版（≤ 24）：弹一个独立窗口「迅雷云盘弹窗」，标题栏下方就是文件夹树。
 *   新版（25.x，实测 25.1.20.1645）：弹的是**迅雷主窗口**（标题「迅雷」），
 *     里面叠一个「文件上传」模态框；要点它的文件夹图标，再开一个子窗口
 *     「选择云盘位置」，在里面选文件夹并「确认」，最后回到「文件上传」点
 *     「确定」才真正提交上传。
 *
 * 两者都是 Chromium/CEF 自绘、UI Automation 读不到控件，所以交给
 * lib/xunlei-upload.ps1 按窗口相对坐标驱动；脚本会自己判别版本走对应路径。
 * 利用「同名文件夹不可重复创建、且会把已存在的那个选中」这一行为做到幂等。
 *
 * 校验则走迅雷云盘客户端的本地 HTTP 接口（pan-cli / xllite，监听 127.0.0.1）。
 * 该接口对读操作开放：GET / 会在 HTML 里注入一枚 uiauth JWT，之后所有请求带上
 * `pan-auth: <jwt>` 即可列目录。写操作需要设备在线，本项目不使用（只读）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_SCRIPT = path.join(HERE, 'xunlei-upload.ps1');

/** 常见的迅雷安装位置，作为注册表查不到时的兜底。 */
const THUNDER_FALLBACKS = [
  'C:\\Program Files (x86)\\Thunder Network\\Thunder\\Program\\Thunder.exe',
  'C:\\Program Files\\Thunder Network\\Thunder\\Program\\Thunder.exe',
  'D:\\Program Files (x86)\\Thunder Network\\Thunder\\Program\\Thunder.exe',
  'D:\\Program Files\\Thunder Network\\Thunder\\Program\\Thunder.exe',
];

/** 本地云盘接口的候选端口。 */
const PAN_PORT_CANDIDATES = [10581, 10574, 5050, 21603];

/**
 * 云盘根目录里由迅雷固定的特殊节点。
 *
 * 这些名字在文件夹树里由迅雷**固定渲染**（不参与「真实文件夹按接口顺序排下来」
 * 的推算），所以计算行号时必须从接口返回的列表里排除。
 *
 * 「新建文件夹」也在其中：新版迅雷把新建入口同时做成了树里的一个固定节点
 * （第 3 行），而它通常也真实存在于云盘根目录，若不清除就会**重复计一次**，
 * 导致后面所有文件夹行号整体 +1、点错文件夹。
 */
const SPECIAL_ROOT_FOLDERS = new Set(['我的转存', '我的资源', '超级保险箱', '新建文件夹']);

/**
 * 真实文件夹之前的固定行数。
 *
 * 旧版（「迅雷云盘弹窗」）：0 = 我的云盘，1 = 我的转存，2 = 我的资源，
 * 真实文件夹从第 3 行开始。
 *
 * 新版（迅雷 25.x 的「选择云盘位置」）：多了一个「新建文件夹」节点，
 * 顺序是 0 = 我的云盘，1 = 我的转存，2 = 我的资源，3 = 新建文件夹，
 * 真实文件夹从第 4 行开始。
 */
export const FIXED_ROWS_LEGACY = 3;
export const FIXED_ROWS_MODERN = 4;

/** 排除固定节点后的根目录真实文件夹，顺序与弹窗树一致。 */
export function realRootFolders(rootEntries) {
  return rootEntries.filter(
    (entry) => entry.kind === 'drive#folder' && !SPECIAL_ROOT_FOLDERS.has(entry.name),
  );
}

/**
 * 目标文件夹在弹窗树里的行号。
 *
 * 树的渲染顺序与 `GET /drive/v1/files?parent_id=` 返回的文件夹顺序一致。
 * 返回 -1 表示目标文件夹还不存在（调用方应改走「新建文件夹」路径）。
 *
 * 注意：这里的行号是**相对整棵树**的，两个版本只有起始行不同，所以只差一个偏移。
 * 脚本会按自己识别到的版本用对应的起始行去点，不依赖额外传参。
 *
 * @param {Array} rootEntries 根目录条目（本地接口返回的 files）
 * @param {string} folderName 目标文件夹名
 * @param {number} fixedRows  固定行数，取 FIXED_ROWS_MODERN / FIXED_ROWS_LEGACY
 */
export function computeRowIndex(rootEntries, folderName, fixedRows = FIXED_ROWS_MODERN) {
  const index = realRootFolders(rootEntries).findIndex((entry) => entry.name === folderName);
  return index >= 0 ? fixedRows + index : -1;
}

function runPowerShell(script, timeoutMs = 240_000) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

/**
 * 定位迅雷客户端。
 *
 * 优先读 `HKEY_CLASSES_ROOT\Directory\shell\UploadToThunderPan\command`——
 * 那是迅雷自己注册的动词，指向的必然是可用的上传入口；注册表读不到再退回
 * 常见安装路径。
 */
export function findThunder() {
  if (process.platform !== 'win32') return { found: false, exe: null, source: 'unsupported-platform' };

  const query = runPowerShell(
    `(Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\Directory\\shell\\UploadToThunderPan\\command' -ErrorAction SilentlyContinue).'(default)'`,
    20_000,
  );
  if (query.ok && query.stdout) {
    const match = /^\s*"?([^"]+?\.exe)"?/i.exec(query.stdout);
    if (match && existsSync(match[1])) {
      return { found: true, exe: match[1], source: 'registry:UploadToThunderPan' };
    }
  }

  for (const candidate of THUNDER_FALLBACKS) {
    if (existsSync(candidate)) return { found: true, exe: candidate, source: `fallback:${candidate}` };
  }
  return { found: false, exe: null, source: 'not-found' };
}

/** 判断迅雷是否在运行。 */
export function isThunderRunning() {
  const result = runPowerShell(
    `(Get-Process -Name Thunder,xllite -ErrorAction SilentlyContinue | Measure-Object).Count`,
    20_000,
  );
  return result.ok && Number(result.stdout) > 0;
}

/** 启动上传：调用迅雷自己的 -ShellUpload 动词，不阻塞等待。 */
export function launchShellUpload(exe, filePath) {
  const child = spawn(exe, [`-ShellUpload:${filePath}`, '-StartType:Explorer'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return { pid: child.pid ?? null };
}

/** 运行弹窗自动化脚本；返回脚本输出的 JSON。 */
export function driveUploadDialog(filePath, folder, options = {}) {
  if (!existsSync(UPLOAD_SCRIPT)) throw new Error(`缺少自动化脚本：${UPLOAD_SCRIPT}`);
  const timeoutSeconds = options.timeoutSeconds ?? 180;
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    UPLOAD_SCRIPT,
    '-ZipPath',
    filePath,
    '-Folder',
    folder,
    '-RowIndex',
    String(Number.isInteger(options.rowIndex) ? options.rowIndex : -1),
    '-TimeoutSeconds',
    String(timeoutSeconds),
    '-Layout',
    String(options.layout ?? 'auto'),
  ];
  const result = spawnSync('powershell.exe', args, {
    encoding: 'utf8',
    timeout: (timeoutSeconds + 60) * 1000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();
  let parsed = null;
  const line = stdout.split(/\r?\n/).filter(Boolean).pop();
  if (line) {
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
  }
  if (parsed === null) {
    return {
      ok: false,
      status: 'automation-failed',
      message: stderr || stdout || `powershell 退出码 ${String(result.status)}`,
      raw: { stdout, stderr, status: result.status },
    };
  }
  if (stderr && parsed.ok === true) parsed.stderr = stderr;
  return parsed;
}

// --- 本地云盘只读接口 --------------------------------------------------------

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    const padded = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** 探测本地云盘接口，拿到端口与 uiauth 令牌。 */
export async function discoverLocalPan(timeoutMs = 4000) {
  const candidates = [...PAN_PORT_CANDIDATES];
  // 再补上迅雷自己暴露的其它本地端口，避免端口被占用后换了号。
  try {
    const extra = runPowerShell(
      `(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::') } | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique) -join ','`,
      15_000,
    );
    if (extra.ok && extra.stdout) {
      for (const port of extra.stdout.split(',').map((v) => Number(v.trim()))) {
        if (Number.isInteger(port) && port > 0 && !candidates.includes(port)) candidates.push(port);
      }
    }
  } catch {
    /* 端口枚举失败不影响候选端口 */
  }

  for (const port of candidates) {
    const base = `http://127.0.0.1:${port}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(`${base}/`, { signal: controller.signal });
      const html = await response.text();
      clearTimeout(timer);
      const match = /function\s+uiauth\s*\(value\)\s*\{\s*return\s*"([^"]+)"/.exec(html);
      if (!match) continue;
      const token = match[1];
      const payload = decodeJwtPayload(token);
      return {
        available: true,
        base,
        port,
        token,
        expiresAt: payload?.exp ? new Date(payload.exp * 1000).toISOString() : null,
      };
    } catch {
      /* 换下一个端口 */
    }
  }
  return { available: false, base: null, port: null, token: null, expiresAt: null };
}

async function panGet(pan, query) {
  const response = await fetch(`${pan.base}/drive/v1/files?${query}`, {
    headers: { 'pan-auth': pan.token },
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

/** 读取云盘配额。 */
export async function quota(pan) {
  try {
    const response = await fetch(`${pan.base}/drive/v1/about`, { headers: { 'pan-auth': pan.token } });
    const json = await response.json();
    return json?.quota ?? null;
  } catch {
    return null;
  }
}

/** 按名字找云盘文件夹，返回 id；找不到返回 null。 */
export async function findFolder(pan, name, parentId = '') {
  const { status, json } = await panGet(pan, `limit=200&parent_id=${encodeURIComponent(parentId)}`);
  if (status !== 200 || !json?.files) return null;
  const hit = json.files.find((file) => file.name === name && file.kind === 'drive#folder');
  return hit ? { id: hit.id, name: hit.name } : null;
}

/** 列出某个文件夹下的文件名。 */
export async function listNames(pan, parentId = '') {
  const { status, json } = await panGet(pan, `limit=200&parent_id=${encodeURIComponent(parentId)}`);
  if (status !== 200 || !json?.files) return null;
  return json.files.map((file) => ({ name: file.name, kind: file.kind, size: file.size ?? null, id: file.id }));
}

/**
 * 等待某个文件名出现在目标云盘文件夹里。
 *
 * 上传是迅雷客户端在后台做的，大小不同耗时不同，所以这里轮询而不是单次检查。
 *
 * @returns {Promise<{verified:boolean, reason:string, folderId:string|null, entry:object|null, waitedMs:number}>}
 */
export async function waitForUpload(pan, archiveName, folderName, options = {}) {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const intervalMs = options.intervalMs ?? 3000;
  const started = Date.now();

  if (!pan?.available) {
    return { verified: false, reason: 'local-pan-api-unavailable', folderId: null, entry: null, waitedMs: 0 };
  }

  // 先确认接口本身可读，否则「找不到文件夹」会把登录过期误报成文件夹不存在。
  const rootNames = await listNames(pan, '');
  if (rootNames === null) {
    return { verified: false, reason: 'local-pan-api-unreachable', folderId: null, entry: null, waitedMs: 0 };
  }

  const folder = await findFolder(pan, folderName);
  if (!folder) {
    return { verified: false, reason: 'cloud-folder-missing', folderId: null, entry: null, waitedMs: 0 };
  }

  while (Date.now() - started < timeoutMs) {
    const names = await listNames(pan, folder.id);
    if (names === null) {
      return {
        verified: false,
        reason: 'local-pan-api-unreachable',
        folderId: folder.id,
        entry: null,
        waitedMs: Date.now() - started,
      };
    }
    const hit = names.find((entry) => entry.name === archiveName);
    if (hit) {
      return {
        verified: true,
        reason: 'found',
        folderId: folder.id,
        entry: hit,
        waitedMs: Date.now() - started,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return {
    verified: false,
    reason: 'timeout',
    folderId: folder.id,
    entry: null,
    waitedMs: Date.now() - started,
  };
}

/**
 * 完整上传流程：启动迅雷上传 → 驱动弹窗选归档文件夹 → 用本地接口确认落点。
 */
export async function uploadArchive(archivePath, options = {}) {
  const folder = options.cloudFolder ?? 'DSH-Backup';
  const log = options.log ?? (() => {});
  const thunder = findThunder();
  if (!thunder.found) {
    return {
      ok: false,
      status: 'thunder-not-found',
      message: '这台机器上找不到迅雷客户端。请先安装迅雷，或手动把备份包拖进迅雷云盘。',
      archive: archivePath,
    };
  }
  log(`迅雷客户端：${thunder.exe}`);

  // 前置检查：先确认迅雷账号已登录、云盘本地接口可读，再碰 UI。
  //
  // 这一步是实测教训换来的：会话过期时迅雷客户端会弹「迅雷登录」窗口并抢走
  // 焦点，自动化按键就会落到登录窗上，而上传弹窗的输入框保留占位文本，
  // 回车后会在云盘根目录建出一个叫「新建文件夹」的空目录。宁可什么都不点，
  // 也不能在未登录状态下乱点。
  const pan = await discoverLocalPan();
  if (!pan.available) {
    return {
      ok: false,
      status: 'pan-unreachable',
      message: '读不到迅雷云盘的本地接口。请确认迅雷客户端已启动，再重试。',
      folder,
      archive: archivePath,
    };
  }
  const rootBefore = await listNames(pan, '');
  if (rootBefore === null) {
    return {
      ok: false,
      status: 'xunlei-not-logged-in',
      message: '迅雷账号当前不可用（本地接口拒绝列目录，通常是登录已过期）。请先在迅雷客户端里登录，再点一次备份。已中止，未操作迅雷界面。',
      folder,
      archive: archivePath,
    };
  }
  const namesBefore = new Set(rootBefore.map((entry) => entry.name));
  // 新版迅雷的「选择云盘位置」比旧版多一个「新建文件夹」固定行，所以真实文件夹
  // 的行号整体 +1。脚本会按自己识别到的版本去点，这里按新版算，旧版由脚本自行
  // 依据窗口标题修正（见 xunlei-upload.ps1 的 layout 分支）。
  const rowIndex = computeRowIndex(rootBefore, folder);
  const quotaInfo = await quota(pan);
  log(
    `迅雷云盘可用：根目录 ${rootBefore.length} 项` +
      (quotaInfo ? `，空间 ${(quotaInfo.usage / 1024 ** 3).toFixed(1)}/${(quotaInfo.limit / 1024 ** 4).toFixed(1)} TB` : ''),
  );
  log(
    rowIndex >= 0
      ? `「${folder}」已存在，将直接点选文件夹树里的第 ${rowIndex} 行`
      : `「${folder}」还不存在，将在文件夹树里新建`,
  );

  const running = isThunderRunning();
  log(running ? '迅雷正在运行，直接调起上传界面' : '迅雷未运行，先启动客户端（首次启动可能需要十几秒）');

  launchShellUpload(thunder.exe, archivePath);
  log('已调用 Thunder.exe -ShellUpload，等待迅雷上传界面…');

  const dialog = driveUploadDialog(archivePath, folder, {
    timeoutSeconds: options.dialogTimeoutSeconds ?? 180,
    rowIndex,
    layout: options.layout ?? 'auto',
  });

  if (!dialog.ok) {
    return {
      ok: false,
      status: dialog.status ?? 'dialog-failed',
      message: dialog.message ?? '迅雷上传界面自动化失败',
      dialog,
      archive: archivePath,
    };
  }
  log(`上传目标已确认，归档文件夹「${folder}」`);

  // 如果自动化期间云盘根目录多出了别的文件夹（典型是「新建文件夹」），
  // 说明当时焦点被别的窗口抢走了，应如实提示用户清理，而不是假装无事。
  const rootAfter = await listNames(pan, '');
  const strayFolders = rootAfter
    ? rootAfter
        .filter((entry) => entry.kind === 'drive#folder' && !namesBefore.has(entry.name) && entry.name !== folder)
        .map((entry) => entry.name)
    : [];

  const archiveName = path.basename(archivePath);
  log('正在通过迅雷云盘本地接口确认文件已归档…');
  const verification = await waitForUpload(pan, archiveName, folder, {
    timeoutMs: options.verifyTimeoutMs ?? 300_000,
    intervalMs: options.verifyIntervalMs ?? 3000,
  });

  const cleanupHint =
    strayFolders.length > 0
      ? `另外，本次操作期间云盘根目录多出了文件夹：${strayFolders.join('、')}。这通常意味着自动化时焦点被别的窗口抢走了，建议在迅雷云盘里删除它们。`
      : '';

  if (verification.verified) {
    log(`已确认：${folder}/${archiveName}（等待 ${Math.round(verification.waitedMs / 1000)} 秒）`);
    return {
      ok: true,
      status: 'verified',
      message: `已上传并确认归档到迅雷网盘「${folder}/${archiveName}」`,
      folder,
      folderId: verification.folderId,
      archive: archivePath,
      entry: verification.entry,
      dialog,
      verification,
      strayFolders,
      cleanupHint,
    };
  }

  const reasonText =
    verification.reason === 'cloud-folder-missing'
      ? `云盘根目录里没有名为「${folder}」的文件夹`
      : verification.reason === 'local-pan-api-unreachable'
        ? '本地云盘接口中断'
        : '等待超时';
  return {
    ok: true,
    status: 'submitted-unverified',
    message: `上传已提交，但未能在超时时间内确认「${folder}」里出现该文件（${reasonText}）。请在迅雷云盘里核实。`,
    folder,
    folderId: verification.folderId,
    archive: archivePath,
    dialog,
    verification,
    strayFolders,
    cleanupHint,
  };
}
