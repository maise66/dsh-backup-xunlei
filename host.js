/**
 * dsh-backup-xunlei 宿主半。
 *
 * 同一个动作 `runBackup()`（lib/service.js）通过三个入口暴露：
 *
 *   1. `POST /backup-xunlei/run` + `GET /backup-xunlei/status`
 *      → 设置面板「备份与迅雷网盘」页面上的按钮（client.js 轮询进度）
 *   2. `/backup-xunlei`      → dsh-commands 的斜杠命令
 *   3. `backup_xunlei`       → dsh-tools 的 Agent 工具
 *
 * 之所以走「启动 + 轮询」，是因为一次完整备份包含打包（几十 MB 压缩）和
 * 迅雷客户端后台上传，往往要几十秒到几分钟；HTTP 请求不该挂那么久。
 *
 * 配置（可在 profile 的 cordis.patch.yml 里按 id 覆盖）：
 * - `enabled`        {boolean}  关掉整个插件
 * - `cloudFolder`    {string}   云盘归档文件夹名，默认 `DSH-Backup`
 * - `includePlugins` {boolean}  是否打包插件实体，默认 true
 * - `includeSkills`  {boolean}  是否打包技能，默认 true
 * - `keepArchives`   {number}   本地保留最近几个备份包，默认 5（0 = 全部保留）
 *
 * lib 的 import 带 `?gen=N`：Node 的 ESM 注册表按说明符缓存模块，Host 进程
 * 长期存活，普通相对路径会一直用第一次加载的那份代码；改 lib 后把这个数字
 * 加一才会真正重新加载。
 */

import { loadState } from './lib/state.js?gen=4';
import { probeEnvironment, runBackup } from './lib/service.js?gen=4';

const RUN_ROUTE = '/backup-xunlei/run';
const STATUS_ROUTE = '/backup-xunlei/status';

/** Host 入口结构变化时 +1，便于识别旧的模块代次。 */
const PLUGIN_VERSION = 2;

const FALLBACK_REJECTION = 403;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonBody(text) {
  if (!text || text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 把一次运行的结果压成一行中文摘要，给命令和工具共用。 */
export function summarize(result) {
  if (!result) return '没有结果';
  if (result.ok === false) return `备份失败：${result.message ?? result.status ?? '未知原因'}`;
  const megabytes = (result.zipBytes / 1024 / 1024).toFixed(1);
  const changes = result.scan?.diff;
  const changeText =
    changes === undefined
      ? ''
      : changes.firstRun
        ? '（首次备份，建立基准）'
        : changes.hasChanges
          ? `（本次变动：插件 +${changes.plugins.added.length}/~${changes.plugins.updated.length}，技能 +${changes.skills.added.length}/~${changes.skills.updated.length}）`
          : '（与上次相比无变化）';
  const upload = result.upload ?? {};
  const uploadText =
    upload.status === 'verified'
      ? `已上传并确认：迅雷网盘 / ${result.cloudFolder}`
      : upload.status === 'submitted-unverified'
        ? `已提交上传，但未能自动确认落点（${upload.verification?.reason ?? '未知'}）`
        : upload.status === 'skipped'
          ? '未上传（按参数跳过）'
          : `上传未完成：${upload.message ?? upload.status ?? '未知'}`;
  return [
    `备份包 ${result.archiveName}（${megabytes} MB，${result.entries} 个条目）${changeText}`,
    uploadText,
    `本地路径：${result.archive}`,
  ].join('\n');
}

export function apply(ctx, config) {
  if (config?.enabled === false) return;

  const settings = {
    cloudFolder: typeof config?.cloudFolder === 'string' && config.cloudFolder ? config.cloudFolder : 'DSH-Backup',
    includePlugins: config?.includePlugins !== false,
    includeSkills: config?.includeSkills !== false,
    keepArchives: Number.isInteger(config?.keepArchives) ? config.keepArchives : 5,
  };

  /** 同时只允许一次备份在跑；后到的调用共享同一次运行。 */
  let job = null;

  function currentJob() {
    if (job === null) return null;
    return job;
  }

  function startJob(overrides = {}) {
    if (job !== null) return job;
    const state = {
      id: `backup-${Date.now()}`,
      startedAt: new Date().toISOString(),
      running: true,
      logs: [],
      result: null,
      error: null,
    };
    const log = (message) => {
      state.logs.push({ at: Date.now(), message: String(message) });
      if (state.logs.length > 400) state.logs.splice(0, state.logs.length - 400);
    };
    job = state;
    log(`开始备份：云盘文件夹「${settings.cloudFolder}」`);
    runBackup({
      cloudFolder: settings.cloudFolder,
      includePlugins: settings.includePlugins,
      includeSkills: settings.includeSkills,
      keepArchives: settings.keepArchives,
      force: overrides.force === true,
      upload: overrides.upload !== false,
      log,
    })
      .then((result) => {
        state.result = result;
        state.running = false;
      })
      .catch((error) => {
        state.error = error?.message ?? String(error);
        state.running = false;
        log(`失败：${state.error}`);
      });
    return state;
  }

  async function statusPayload() {
    const state = currentJob();
    const dshHome = process.env.DSH_HOME;
    const persisted = dshHome ? await loadState(dshHome) : null;
    return {
      ok: true,
      version: PLUGIN_VERSION,
      settings,
      running: state?.running === true,
      job: state === null ? null : { id: state.id, startedAt: state.startedAt, logs: state.logs },
      result: state?.result ?? null,
      error: state?.error ?? null,
      history: persisted?.history ?? [],
      lastBackupAt: persisted?.lastBackupAt ?? null,
      lastArchive: persisted?.lastArchive ?? null,
    };
  }

  // --- 1. 设置面板用的 HTTP 路由 -------------------------------------------
  ctx.inject(['webServer', 'connection'], (scope) => {
    const rejectUntrusted = (req, res) => {
      const rejection = scope.connection.requestRejection(req);
      if (rejection === undefined || rejection === null) return false;
      res.statusCode = Number(rejection) || FALLBACK_REJECTION;
      res.end();
      return true;
    };

    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: STATUS_ROUTE,
          handler: async (req, res) => {
            if (rejectUntrusted(req, res)) return;
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.statusCode = 405;
              res.setHeader('allow', 'GET, HEAD');
              res.end();
              return;
            }
            try {
              sendJson(res, 200, await statusPayload());
            } catch (error) {
              sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
            }
          },
        }),
      'backup-xunlei: GET /backup-xunlei/status',
    );

    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: RUN_ROUTE,
          handler: async (req, res) => {
            if (rejectUntrusted(req, res)) return;
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('allow', 'POST');
              res.end();
              return;
            }
            try {
              const body = parseJsonBody(await readBody(req));
              const state = startJob({ force: body?.force === true, upload: body?.upload !== false });
              sendJson(res, 200, { ok: true, jobId: state.id, running: state.running });
            } catch (error) {
              sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
            }
          },
        }),
      'backup-xunlei: POST /backup-xunlei/run',
    );

    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/backup-xunlei/probe',
          handler: async (req, res) => {
            if (rejectUntrusted(req, res)) return;
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.statusCode = 405;
              res.setHeader('allow', 'GET, HEAD');
              res.end();
              return;
            }
            try {
              sendJson(res, 200, { ok: true, environment: await probeEnvironment() });
            } catch (error) {
              sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
            }
          },
        }),
      'backup-xunlei: GET /backup-xunlei/probe',
    );
  });

  // --- 2. 斜杠命令 ---------------------------------------------------------
  ctx.inject(['commands'], (scope) => {
    scope.effect(
      () =>
        scope.commands.register({
          name: 'backup-xunlei',
          description: '把本机的 DSH 插件与技能打包并上传到迅雷网盘（归档到指定文件夹）',
          input: { hint: '[--no-upload] [--force]' },
          handler: async ({ rawInput }) => {
            const text = String(rawInput ?? '');
            try {
              const result = await runBackup({
                cloudFolder: settings.cloudFolder,
                includePlugins: settings.includePlugins,
                includeSkills: settings.includeSkills,
                keepArchives: settings.keepArchives,
                upload: !/--no-upload/.test(text),
                force: /--force/.test(text),
                log: () => {},
              });
              return { kind: 'success', text: summarize(result) };
            } catch (error) {
              return { kind: 'error', text: error?.message ?? String(error) };
            }
          },
        }),
      'backup-xunlei: /backup-xunlei command',
    );
  });

  // --- 3. Agent 工具 -------------------------------------------------------
  ctx.inject(['tools'], (scope) => {
    scope.effect(
      () =>
        scope.tools.register({
          name: 'backup_xunlei',
          description:
            '把当前设备上的 DeepSeek Harness 插件与技能打包成一个备份 ZIP，并上传到迅雷网盘的归档文件夹（默认 DSH-Backup）。会上报相对上次备份新增/变更了哪些插件和技能。上传过程会短暂调起迅雷上传界面并自动点两次确认（新版迅雷：先在「选择云盘位置」里选文件夹，再在主界面点「确定」），请勿同时操作鼠标。',
          parameters: {
            type: 'object',
            properties: {
              upload: {
                type: 'boolean',
                description: '是否上传到迅雷网盘；false 表示只在本地生成备份包。默认 true。',
              },
              force: {
                type: 'boolean',
                description: '即使与上次备份相比没有变化也照样生成并上传。默认 false。',
              },
            },
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                archive: { type: 'string', description: '本地备份包路径' },
                archiveName: { type: 'string' },
                zipBytes: { type: 'number' },
                cloudFolder: { type: 'string' },
                uploadStatus: { type: 'string' },
                uploadMessage: { type: 'string' },
                summary: { type: 'string' },
                counts: {
                  type: 'object',
                  properties: {
                    plugins: { type: 'number' },
                    pluginsPresent: { type: 'number' },
                    skills: { type: 'number' },
                  },
                  additionalProperties: true,
                },
                changes: { type: 'object', additionalProperties: true },
              },
              required: ['ok', 'summary'],
              additionalProperties: true,
            },
            render: (_args, value) => [{ type: 'text', text: value.summary }],
          },
          async execute(args) {
            const result = await runBackup({
              cloudFolder: settings.cloudFolder,
              includePlugins: settings.includePlugins,
              includeSkills: settings.includeSkills,
              keepArchives: settings.keepArchives,
              upload: args?.upload !== false,
              force: args?.force === true,
              log: () => {},
            });
            return {
              ok: result.ok,
              archive: result.archive,
              archiveName: result.archiveName,
              zipBytes: result.zipBytes,
              cloudFolder: result.cloudFolder,
              uploadStatus: result.upload?.status ?? null,
              uploadMessage: result.upload?.message ?? null,
              counts: result.scan?.totals ?? null,
              changes: result.scan?.diff ?? null,
              summary: summarize(result),
            };
          },
        }),
      'backup-xunlei: backup_xunlei tool',
    );
  });
}
