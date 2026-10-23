/**
 * dsh-backup-xunlei 浏览器半。
 *
 * 在「设置」里注册一个页面：备份与迅雷网盘。页面上有
 *   - 环境体检：迅雷客户端位置、云盘本地接口、配额、上次备份时间
 *   - 一键按钮：打包本机插件与技能并上传到迅雷网盘
 *   - 运行日志：实时轮询宿主进度
 *   - 历史记录：最近几次备份的落点与结果
 *
 * 工厂保持无副作用：样式表作为 React 子节点渲染（卸载即移除），所有注册都在
 * apply 里带自己的 disposer。
 */

window.__ModuleLoader__.load({
  id: 'dsh-backup-xunlei',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'backup-xunlei';
    const STATUS_ROUTE = '/backup-xunlei/status';
    const RUN_ROUTE = '/backup-xunlei/run';
    const PROBE_ROUTE = '/backup-xunlei/probe';

    const zh = {
      section: '备份与迅雷网盘',
      title: '备份与迅雷网盘',
      intro:
        '把当前设备上的 DSH 插件与技能打包，上传到迅雷网盘的归档文件夹。换机器时解压备份包，运行里面的 restore.ps1 即可还原。',
      run: '一键备份并上传',
      runLocal: '只打包，不上传',
      running: '正在备份…',
      refresh: '刷新状态',
      probing: '体检中…',
      environment: '环境',
      thunder: '迅雷客户端',
      thunderOk: '已找到',
      thunderMissing: '未找到',
      panApi: '云盘本地接口',
      panOk: '可读（端口 {port}）',
      panMissing: '不可读（不影响上传，只影响自动确认）',
      quota: '云盘空间',
      lastBackup: '上次备份',
      never: '还没有备份过',
      changes: '待备份的变动',
      noChanges: '与上次相比没有变化',
      firstRun: '第一次备份，将建立基准',
      added: '新增',
      updated: '变更',
      plugins: '插件',
      skills: '技能',
      log: '运行日志',
      history: '备份历史',
      noHistory: '还没有历史记录',
      result: '结果',
      uploadOk: '已上传并确认',
      uploadMaybe: '已提交，未能自动确认',
      uploadFail: '上传未完成',
      localOnly: '仅本地打包',
      failed: '失败',
      offline: '无法连接宿主进程',
      close: '关闭',
      folderLabel: '云盘归档文件夹',
      openFolder: '本地备份目录',
      hint: '提示：上传时会短暂弹出迅雷的「选择云盘保存路径」窗口并自动点确定，这几秒请不要操作鼠标。',
      bytes: '体积',
      entries: '条目',
    };

    const en = {
      section: 'Backup & Xunlei Drive',
      title: 'Backup & Xunlei Drive',
      intro:
        'Pack this device’s DSH plugins and skills and upload the archive to your Xunlei cloud drive folder. On another machine, unzip it and run restore.ps1.',
      run: 'Back up and upload',
      runLocal: 'Pack only',
      running: 'Backing up…',
      refresh: 'Refresh',
      probing: 'Checking…',
      environment: 'Environment',
      thunder: 'Xunlei client',
      thunderOk: 'found',
      thunderMissing: 'not found',
      panApi: 'Local drive API',
      panOk: 'readable (port {port})',
      panMissing: 'unreadable (upload still works, only auto-verify is skipped)',
      quota: 'Cloud space',
      lastBackup: 'Last backup',
      never: 'No backup yet',
      changes: 'Pending changes',
      noChanges: 'No change since the last backup',
      firstRun: 'First backup — a baseline will be created',
      added: 'added',
      updated: 'updated',
      plugins: 'Plugins',
      skills: 'Skills',
      log: 'Log',
      history: 'History',
      noHistory: 'No history yet',
      result: 'Result',
      uploadOk: 'Uploaded and verified',
      uploadMaybe: 'Submitted, not verified',
      uploadFail: 'Upload incomplete',
      localOnly: 'Local archive only',
      failed: 'Failed',
      offline: 'Cannot reach the host process',
      close: 'Close',
      folderLabel: 'Cloud folder',
      openFolder: 'Local backup folder',
      hint:
        'Note: the upload briefly opens Xunlei’s “choose cloud save path” dialog and clicks OK automatically. Please avoid using the mouse for those seconds.',
      bytes: 'Size',
      entries: 'Entries',
    };

    const CSS = `
.bxl-root{font-family:var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.7;max-width:760px}
.bxl-card{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);padding:14px 16px;margin:0 0 14px;background:var(--dsw-alias-bg-base)}
.bxl-h{margin:0 0 8px;font-size:13px;font-weight:600}
.bxl-p{margin:0 0 10px;color:var(--dsw-alias-label-secondary)}
.bxl-rows{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0}
.bxl-k{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.bxl-v{color:var(--dsw-alias-label-primary);word-break:break-all}
.bxl-ok{color:var(--dsw-alias-state-success-primary)}
.bxl-warn{color:var(--dsw-alias-state-warning-primary,#b7791f)}
.bxl-err{color:var(--dsw-alias-state-error-primary)}
.bxl-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0 4px}
.bxl-btn{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 16px;border:1px solid transparent;border-radius:9px;font-size:13px;font-family:inherit;cursor:pointer;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-inverse,#fff)}
.bxl-btn:hover:not(:disabled){filter:brightness(1.06)}
.bxl-btn:disabled{opacity:.55;cursor:default}
.bxl-btn.ghost{background:transparent;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.bxl-btn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.bxl-log{max-height:220px;overflow:auto;margin:0;padding:10px 12px;border-radius:9px;background:var(--dsw-alias-bg-sunken,var(--dsw-alias-bg-overlay));border:1px solid var(--dsw-alias-border-l2);font-family:var(--dsw-font-family-mono,ui-monospace,Consolas,monospace);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary)}
.bxl-list{margin:0;padding:0;list-style:none}
.bxl-item{padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.bxl-item:first-child{border-top:0}
.bxl-item .t{color:var(--dsw-alias-label-primary)}
.bxl-item .s{color:var(--dsw-alias-label-tertiary);font-size:12px}
.bxl-chip{display:inline-block;padding:1px 7px;margin-right:6px;border-radius:999px;font-size:11px;line-height:18px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.bxl-spin{transform-origin:50% 50%;animation:bxl-rotate 900ms linear infinite}
@keyframes bxl-rotate{to{transform:rotate(360deg)}}
`;

    function fill(text, values) {
      let out = String(text);
      for (const [key, value] of Object.entries(values)) out = out.split(`{${key}}`).join(String(value));
      return out;
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) return `${String(value)} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let size = value / 1024;
      let index = 0;
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }
      return `${size >= 100 ? String(Math.round(size)) : size.toFixed(1)} ${units[index]}`;
    }

    function formatTime(iso) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return String(iso);
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function Spinner({ size = 15 }) {
      return h(
        'svg',
        { className: 'bxl-spin', viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true' },
        h('circle', { cx: 8, cy: 8, r: 6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, opacity: 0.25 }),
        h('path', { d: 'M8 2a6 6 0 0 1 6 6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
      );
    }

    function CloudIcon({ size = 16 }) {
      const stroke = {
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      };
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', style: { flex: 'none' } },
        h('path', { d: 'M7 18a4 4 0 0 1-.4-7.98A5.5 5.5 0 0 1 17.4 9.2A3.6 3.6 0 0 1 17 18z', ...stroke }),
        h('path', { d: 'M12 11.5v5.2M9.8 14.4 12 16.6l2.2-2.2', ...stroke }),
      );
    }

    function Row({ label, children, tone }) {
      return h(
        React.Fragment,
        null,
        h('div', { className: 'bxl-k' }, label),
        h('div', { className: `bxl-v${tone ? ` ${tone}` : ''}` }, children),
      );
    }

    function ChangeLine({ label, rows, t }) {
      if (!rows) return null;
      const parts = [];
      if (rows.added.length > 0) parts.push(`${t('added')} ${rows.added.length}（${rows.added.slice(0, 6).join('、')}）`);
      if (rows.updated.length > 0) parts.push(`${t('updated')} ${rows.updated.length}（${rows.updated.slice(0, 6).join('、')}）`);
      if (parts.length === 0) return null;
      return h('div', { className: 'bxl-v' }, `${label}：${parts.join('；')}`);
    }

    function BackupSection({ t }) {
      const [status, setStatus] = React.useState(null);
      const [environment, setEnvironment] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [localOnly, setLocalOnly] = React.useState(false);
      const timer = React.useRef(null);

      const loadStatus = React.useCallback(async () => {
        try {
          const response = await fetch(STATUS_ROUTE, { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
          const payload = await response.json();
          setStatus(payload);
          setError(null);
          return payload;
        } catch (cause) {
          setError(cause?.message ?? String(cause));
          return null;
        }
      }, []);

      const loadEnvironment = React.useCallback(async () => {
        try {
          const response = await fetch(PROBE_ROUTE, { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
          const payload = await response.json();
          setEnvironment(payload?.environment ?? null);
        } catch (cause) {
          setError(cause?.message ?? String(cause));
        }
      }, []);

      // 首屏拉一次状态与体检结果。
      React.useEffect(() => {
        let alive = true;
        (async () => {
          const payload = await loadStatus();
          if (alive && payload?.running !== true) await loadEnvironment();
        })();
        return () => {
          alive = false;
        };
      }, [loadStatus, loadEnvironment]);

      // 只要宿主还在跑，就持续轮询。
      React.useEffect(() => {
        const running = status?.running === true;
        if (!running) {
          if (timer.current !== null) {
            clearInterval(timer.current);
            timer.current = null;
          }
          return undefined;
        }
        if (timer.current === null) {
          timer.current = setInterval(() => {
            void loadStatus();
          }, 1500);
        }
        return undefined;
      }, [status?.running, loadStatus]);

      React.useEffect(
        () => () => {
          if (timer.current !== null) clearInterval(timer.current);
        },
        [],
      );

      const run = async (upload) => {
        if (busy) return;
        setBusy(true);
        setLocalOnly(!upload);
        setError(null);
        try {
          const response = await fetch(RUN_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ upload }),
          });
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
          await loadStatus();
          if (timer.current === null) {
            timer.current = setInterval(() => {
              void loadStatus();
            }, 1500);
          }
          if (!upload) void loadEnvironment();
        } catch (cause) {
          setError(cause?.message ?? String(cause));
        } finally {
          setBusy(false);
        }
      };

      const running = status?.running === true;
      const result = status?.result ?? null;
      const logs = status?.job?.logs ?? [];
      const history = status?.history ?? [];
      const diff = environment?.diff ?? null;
      const thunder = environment?.thunder ?? null;
      const pan = environment?.pan ?? null;
      const quota = environment?.quota ?? null;

      const uploadTone = (state) => {
        if (state === 'verified') return 'bxl-ok';
        if (state === 'submitted-unverified') return 'bxl-warn';
        if (state === 'skipped') return '';
        return 'bxl-err';
      };

      const uploadText = (state) => {
        if (state === 'verified') return t('uploadOk');
        if (state === 'submitted-unverified') return t('uploadMaybe');
        if (state === 'skipped') return t('localOnly');
        return t('uploadFail');
      };

      return h(
        'div',
        { className: 'bxl-root' },
        h('style', null, CSS),
        h('p', { className: 'bxl-p' }, t('intro')),

        h(
          'div',
          { className: 'bxl-card' },
          h('p', { className: 'bxl-h' }, t('environment')),
          h(
            'div',
            { className: 'bxl-rows' },
            h(Row, {
              label: t('thunder'),
              tone: thunder?.found ? 'bxl-ok' : 'bxl-err',
              children: thunder?.found ? `${t('thunderOk')} · ${thunder.exe}` : t('thunderMissing'),
            }),
            h(Row, {
              label: t('panApi'),
              tone: pan?.available ? 'bxl-ok' : 'bxl-warn',
              children: pan?.available ? fill(t('panOk'), { port: pan.port }) : t('panMissing'),
            }),
            quota
              ? h(Row, {
                  label: t('quota'),
                  children: `${formatBytes(quota.usage)} / ${formatBytes(quota.limit)}`,
                })
              : null,
            h(Row, {
              label: t('folderLabel'),
              children: status?.settings?.cloudFolder ?? 'DSH-Backup',
            }),
            h(Row, {
              label: t('lastBackup'),
              children: environment?.lastBackupAt ? formatTime(environment.lastBackupAt) : t('never'),
            }),
            h(
              Row,
              { label: t('changes') },
              diff === null
                ? '—'
                : diff.firstRun
                  ? t('firstRun')
                  : diff.hasChanges
                    ? h(
                        React.Fragment,
                        null,
                        h(ChangeLine, { label: t('plugins'), rows: diff.plugins, t }),
                        h('div', null, h(ChangeLine, { label: t('skills'), rows: diff.skills, t })),
                      )
                    : t('noChanges'),
            ),
          ),
          h(
            'div',
            { className: 'bxl-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'bxl-btn',
                disabled: running || busy,
                onClick: () => void run(true),
              },
              running ? h(Spinner, null) : h(CloudIcon, null),
              running ? t('running') : t('run'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'bxl-btn ghost',
                disabled: running || busy,
                onClick: () => void run(false),
              },
              t('runLocal'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'bxl-btn ghost',
                disabled: running || busy,
                onClick: () => {
                  void loadStatus();
                  void loadEnvironment();
                },
              },
              t('refresh'),
            ),
          ),
          h('p', { className: 'bxl-p' }, t('hint')),
        ),

        error !== null
          ? h('div', { className: 'bxl-card' }, h('p', { className: 'bxl-h bxl-err' }, t('failed')), h('p', { className: 'bxl-p' }, error))
          : null,

        logs.length > 0
          ? h(
              'div',
              { className: 'bxl-card' },
              h('p', { className: 'bxl-h' }, t('log')),
              h('pre', { className: 'bxl-log' }, logs.map((entry) => entry.message).join('\n')),
            )
          : null,

        result
          ? h(
              'div',
              { className: 'bxl-card' },
              h('p', { className: 'bxl-h' }, t('result')),
              h(
                'div',
                { className: 'bxl-rows' },
                h(Row, { label: t('bytes'), children: `${result.archiveName} · ${formatBytes(result.zipBytes)} · ${result.entries} ${t('entries')}` }),
                h(Row, {
                  label: '上传',
                  tone: uploadTone(result.upload?.status),
                  children: uploadText(result.upload?.status),
                }),
                h(Row, { label: t('openFolder'), children: result.archive }),
                result.upload?.message ? h(Row, { label: '说明', children: result.upload.message }) : null,
              ),
            )
          : null,

        history.length > 0
          ? h(
              'div',
              { className: 'bxl-card' },
              h('p', { className: 'bxl-h' }, t('history')),
              h(
                'ul',
                { className: 'bxl-list' },
                history.slice(0, 8).map((entry, index) =>
                  h(
                    'li',
                    { className: 'bxl-item', key: `${entry.at}-${String(index)}` },
                    h('div', { className: 't' }, entry.archive || '(未命名)'),
                    h(
                      'div',
                      { className: 's' },
                      h('span', { className: 'bxl-chip' }, formatTime(entry.at)),
                      h('span', { className: 'bxl-chip' }, entry.uploadStatus ?? 'unknown'),
                      `插件 ${entry.plugins ?? 0} · 技能 ${entry.skills ?? 0}${entry.zipBytes ? ` · ${formatBytes(entry.zipBytes)}` : ''}`,
                    ),
                  ),
                ),
              ),
            )
          : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'backup-xunlei: locale dictionaries');
        const t = ctx.locale.bind(NS);

        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'backup-xunlei',
                  order: 50,
                  label: () => t('section'),
                },
                () => h(BackupSection, { t }),
              ),
            ),
          'backup-xunlei: settings section',
        );
      },
    };
  },
});
