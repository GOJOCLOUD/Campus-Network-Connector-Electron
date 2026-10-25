/**
 * 浏览器复制修复（Windows 线）—— 功能模块入口。
 *
 * 由 `src/features/index.js` 的注册表统一加载;新增功能照这个目录的形状做即可。
 *
 * 本功能负责:
 *   - 找到安装包里的 Chromium 扩展（复制修复用的那个）
 *   - 把它注册进 Chrome / Edge 的外部扩展清单（HKCU）
 *   - 关掉开关时把注册表那两把键删掉
 *
 * 与 mac 线的对应关系:
 *   mac  → `safari-repair`（Apple Events 驱动 Safari）
 *   win  → `chromium-repair`（注册表把扩展挂进 Chrome / Edge）
 *
 * 界面上的**开关长得一模一样**（同一个前端组件、同一个位置）——
 * 差别只在背后接的是哪个浏览器（ADR-0013）。
 *
 * 依赖 Windows；其它平台不支持（界面会自动隐藏开关）。
 */
const registry = require('./registry');

/** 本功能在 settings.json 里的配置键（命名空间由注册表按功能 id 隔离） */
const KEY_ENABLED = 'enabled';

/** 上一次失败的因 —— 界面必须把它露出来，
 *  否则用户只看到"已开启"却什么都没发生，根本无从判断是权限还是别的问题。 */
let lastError = '';

/** 记一次失败原因（空串 = 没有失败）。 */
function setLastError(message) {
  lastError = message || '';
}

/**
 * 注册（或注销）扩展。
 *
 * @param {boolean} enabled 开关
 * @returns {{ok: boolean, error?: string}}
 */
function apply(enabled) {
  const dir = registry.findExtensionDir();
  const manifest = dir ? registry.readManifest(dir) : null;
  const id = registry.extensionId(manifest);
  if (!id) {
    const error = manifest
      ? '扩展 manifest 缺少 key 字段，扩展 ID 算不出来'
      : '安装包里找不到浏览器修复扩展（browser-extension 目录）';
    setLastError(error);
    return { ok: false, error };
  }
  const version = manifest.version || '0.1.0';
  const errors = [];
  for (const [browser, label] of registry.BROWSERS) {
    const result = enabled
      ? registry.registerBrowser(browser, id, dir, version)
      : registry.unregisterBrowser(browser, id);
    if (!result.ok) errors.push(`${label}: ${result.error}`);
  }
  if (errors.length) {
    const error = errors.join('；');
    setLastError(error);
    return { ok: false, error };
  }
  setLastError('');
  return { ok: true };
}

/**
 * 现在的状态 —— 界面靠它显示"已接管 / 关闭中 / 失败原因"。
 */
function status(settings) {
  const enabled = !!settings?.get(KEY_ENABLED, false);
  const dir = registry.findExtensionDir();
  const manifest = dir ? registry.readManifest(dir) : null;
  const id = registry.extensionId(manifest);
  const registered = id ? registry.registeredBrowsers(id) : [];
  const running = registry.browsersRunning();
  let hint = '';
  if (enabled && registered.length) {
    hint = running.length
      ? `已注册到 ${registered.join('、')}，但浏览器正在运行 —— 请重启一次浏览器后生效。`
      : `已注册到 ${registered.join('、')}，下次打开浏览器即生效。`;
  }
  return {
    enabled,
    supported: process.platform === 'win32',
    injected: registered.length > 0,
    registered,
    browsersRunning: running,
    hint,
    lastError,
  };
}

function init({ settings } = {}) {
  // 恢复上次的开关状态:把注册表那两把键**重写一遍**。
  //
  // 为什么每次启动都要写:注册表里的 `path` 指向安装目录里的扩展 ——
  // 用户把程序挪了位置(或换了机器重新装),那把键就指着旧路径 ⇒
  // 浏览器启动时找不到扩展 ⇒ 开关显示"已开启"但什么都没发生。
  // 每次启动重写一次 = 自愈,不用用户做任何事。
  if (settings?.get(KEY_ENABLED, false)) {
    apply(true);
  }
  return { apply, status: () => status(settings) };
}

/** 注册 IPC（命名遵循项目既有约定：模块:动作）。 */
function registerIpc(ipcMain, { settings } = {}) {
  ipcMain.handle('chromiumRepair:getStatus', async () => status(settings));

  ipcMain.on('chromiumRepair:setEnabled', (_e, enabled) => {
    apply(!!enabled);
  });

  ipcMain.on('chromiumRepair:setEnabledSetting', (_e, enabled) => {
    settings?.set(KEY_ENABLED, !!enabled);
  });
}

function dispose() {
  /* 注册表里的键**不主动删** —— 用户关了应用不等于要关掉这个功能。 */
}

module.exports = {
  id: 'chromium-repair',
  title: '浏览器复制修复',
  init,
  registerIpc,
  dispose,
  apply,
  status,
};
