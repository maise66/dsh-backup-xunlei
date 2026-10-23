/**
 * 冒烟测试：不需要启动 DSH，直接在两半的真实代码上做进程内验证。
 *
 *   node test/smoke.mjs             只做注册与渲染检查（不联网、不改动云盘）
 *   node test/smoke.mjs --upload    额外真的跑一次 backup_xunlei 工具（会打包并上传）
 *
 * 检查项：
 *   宿主半 —— 三条 HTTP 路由、斜杠命令、Agent 工具是否按契约注册；GET 状态路由能否正常应答。
 *   客户端半 —— 是否注册进 settings.section（id/order/label 契约）；组件能否完成一次渲染。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const withUpload = process.argv.includes('--upload');

let failures = 0;
function check(label, condition, extra = '') {
  if (condition) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label} ${extra}`);
  }
}

// --- 宿主半 -----------------------------------------------------------------
console.log('== host.js ==');
const { apply, summarize } = await import(pathToFileURL(path.join(ROOT, 'host.js')).href);

const registered = { routes: [], commands: [], tools: [] };
const scopeFor = (names) => {
  const scope = { effect: (fn) => fn() };
  if (names.includes('webServer')) {
    scope.webServer = { register: (entry) => void registered.routes.push(entry) };
    scope.connection = { requestRejection: () => undefined };
  }
  if (names.includes('commands')) scope.commands = { register: (entry) => void registered.commands.push(entry) };
  if (names.includes('tools')) scope.tools = { register: (entry) => void registered.tools.push(entry) };
  return scope;
};

apply({ inject: (names, cb) => cb(scopeFor(names)) }, { enabled: true, cloudFolder: 'DSH-Backup', keepArchives: 5 });

check('注册了 3 条 webServer 路由', registered.routes.length === 3, `实际 ${registered.routes.length}`);
check(
  '路由路径齐全',
  registered.routes.map((r) => r.path).sort().join(',') ===
    '/backup-xunlei/probe,/backup-xunlei/run,/backup-xunlei/status',
  registered.routes.map((r) => r.path).join(','),
);
check('注册了 /backup-xunlei 命令', registered.commands.some((c) => c.name === 'backup-xunlei'));
const tool = registered.tools.find((t) => t.name === 'backup_xunlei');
check('注册了 backup_xunlei 工具', Boolean(tool));
check('工具有 output.schema 与 render', Boolean(tool?.output?.schema && tool?.output?.render));
check('工具 parameters 是合法 JSON Schema', tool?.parameters?.type === 'object');

const statusRoute = registered.routes.find((r) => r.path === '/backup-xunlei/status');
const captured = await new Promise((resolve) => {
  const res = {
    statusCode: 0,
    setHeader() {},
    end(body) {
      resolve({ status: this.statusCode, body });
    },
  };
  void statusRoute.handler({ method: 'GET', headers: {}, on() {} }, res);
});
check('GET /backup-xunlei/status 返回 200', captured.status === 200, `实际 ${captured.status}`);
const statusPayload = JSON.parse(captured.body);
check('状态里带 settings 与 history', Boolean(statusPayload.settings && Array.isArray(statusPayload.history)));
console.log('    最后一次备份：', statusPayload.lastBackupAt ?? '(还没有)', '| 云盘文件夹：', statusPayload.settings.cloudFolder);

// --- 客户端半 ---------------------------------------------------------------
console.log('== client.js ==');

const hookCalls = [];
const fakeReact = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => {
    hookCalls.push('useState');
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect: (fn) => {
    hookCalls.push('useEffect');
    try {
      fn();
    } catch (error) {
      hookCalls.push(`useEffect-error:${error.message}`);
    }
    return undefined;
  },
  useRef: (initial) => {
    hookCalls.push('useRef');
    return { current: initial };
  },
  useCallback: (fn) => {
    hookCalls.push('useCallback');
    return fn;
  },
};

let loaded = null;
globalThis.window = { __ModuleLoader__: { load: (definition) => (loaded = definition) } };

// 渲染组件会触发状态查询，这里临时把 fetch 换掉；后面 --upload 之前必须换回来，
// 否则插件探测迅雷本地接口时也会拿到这个假响应（踩过一次）。
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, running: false, settings: { cloudFolder: 'DSH-Backup' }, history: [] }),
});

const requireShim = (name) => {
  if (name === 'react') return fakeReact;
  throw new Error(`客户端半不应 require ${name}`);
};

const source = await readFile(path.join(ROOT, 'client.js'), 'utf8');
new Function('window', 'require', source)(globalThis.window, requireShim);

check('client.js 调用了 __ModuleLoader__.load', loaded !== null);
check('模块 id 是包名', loaded?.id === 'dsh-backup-xunlei', String(loaded?.id));

const seen = { locale: [], slots: [] };
const factory = loaded.factory(requireShim);
check('factory 声明了 inject', Array.isArray(factory?.inject));

factory.apply({
  effect: (fn) => fn(),
  locale: {
    register: (ns, dict) => seen.locale.push({ ns, dict }),
    bind: (ns) => (key) => `${ns}:${key}`,
  },
  slots: {
    inject: (slot, cb) => {
      seen.slots.push(slot);
      cb();
      return () => {};
    },
    register: (options, component) => {
      seen.slots.push({ ...options, component });
      return () => {};
    },
  },
});

check('注册了中英词典', seen.locale.length === 1 && Boolean(seen.locale[0].dict.zh && seen.locale[0].dict.en));
const section = seen.slots.find((s) => s.name === 'settings.section');
check('注册到 settings.section', Boolean(section));
check('section id 为 backup-xunlei', section?.id === 'backup-xunlei', String(section?.id));
check('section 带 order 与 label', section?.order === 50 && typeof section?.label === 'function');

try {
  const wrapper = section.component({ close: () => {} });
  const inner = wrapper.type(wrapper.props);
  check('组件首次渲染不抛错', inner !== null && inner !== undefined);
  check('组件用到了 hooks', hookCalls.includes('useState') && hookCalls.includes('useEffect'));
} catch (error) {
  check('组件首次渲染不抛错', false, `抛出：${error.message}`);
}

// --- 可选：真跑一次工具 ------------------------------------------------------
if (withUpload) {
  globalThis.fetch = realFetch;
  console.log('== backup_xunlei 真实执行（打包 + 上传）==');
  const started = Date.now();
  try {
    const value = await tool.execute({}, {});
    console.log(`  用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
    console.log(tool.output.render({}, value).map((chunk) => `  ${chunk.text}`).join('\n'));
    check('工具执行成功', value.ok === true);
    check('上传已确认', value.uploadStatus === 'verified', String(value.uploadStatus));
    check('summarize 能产出摘要', typeof summarize({ ...value, entries: 0 }) === 'string');
  } catch (error) {
    check('工具执行成功', false, `抛出：${error.message}`);
  }
}

console.log('');
console.log(failures === 0 ? '全部通过 ✅' : `有 ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
