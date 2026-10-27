/**
 * 浏览器复制修复（Windows 线）—— 功能模块入口。
 *
 * 由 `src/features/index.js` 的注册表统一加载;新增功能照这个目录的形状做即可。
 *
 * ## 它是怎么工作的(2026-10-26 起的形态)
 *
 *   1. 用户拨一下开关 → **本软件自己起一个 Edge**(带自己的 profile 目录)
 *   2. 通过 CDP 连上它,给**每个标签页**在 document_start 注入页面守卫
 *      (`Page.addScriptToEvaluateOnNewDocument`)
 *   3. 守卫发现页面里的混淆字体 → 上报给本软件
 *   4. 本软件解析那个字体、和参考字形库比对,算出「密文 → 明文」映射
 *   5. 映射下发回页面;用户按 Ctrl+C 时,守卫在 copy 事件里把明文写进剪贴板
 *
 * ## 为什么是「自己起浏览器」而不是「接管用户平时那个」
 *
 * Chromium ≥136 对默认 profile 直接忽略调试端口 ⇒ 想接管用户日常那个浏览器
 * 就得改他的启动方式(那就不是零点击了)。自己起一个 ⇒ 零点击 + 绑定性满分,
 * 代价是用户得在**这个**窗口里用、首次要扫码登录一次。
 *
 * ## 与 mac 线的对应关系
 *
 *   mac  → `safari-repair`(Apple Events 驱动 Safari)
 *   win  → `chromium-repair`(CDP 驱动本软件自己起的 Edge)
 *
 * 界面上的**开关长得一模一样**(同一个前端组件、同一个位置)——
 * 差别只在背后接哪个浏览器(ADR-0013)。
 *
 * 依赖 Windows;其它平台不支持(界面会自动隐藏开关)。
 */
const path = require('path');
const { ManagedBrowser } = require('./browser');
const { CdpCoordinator } = require('./coordinator');
// 字形还原引擎是**两条线共用**的一份实现(与 mac 线逐字相同),
// 它只管「字体文件 → 密文/明文对照表」,与浏览器怎么驱动无关。
const { GlyphEngine } = require('../safari-repair/engine');
const paths = require('../safari-repair/paths');

/** 本功能在 settings.json 里的配置键（命名空间由注册表按功能 id 隔离） */
const KEY_ENABLED = 'enabled';
const KEY_WATCHED = 'watched';

let coordinator = null;
let browser = null;

/**
 * 界面上的提示文案 —— 必须说**确实会发生**的事：
 * 本软件会开一个自己的浏览器窗口，用户要在那个窗口里用。
 *
 * ⚠️ **要短**（2026-10-27 用户口径：「这个界面说明太详细了，看起来乱七八糟的，
 *    不够简短」）。以前这句话把「关掉不自动重开」「首次扫码」全塞进去
 * ⇒ 那一栏变成三大段密密麻麻的字 ⇒ 看着乱。
 * 细节挪到界面下方的说明与文档里；界面上只留**必须当下知道的一句**。
 */
const HINT_ON = '请在本软件开的 Edge 窗口里上网、答题';

function init({ log, settings, app } = {}) {
  if (coordinator) return coordinator;
  const userData = app && app.getPath ? app.getPath('userData') : path.join(process.cwd(), '.cnc-userdata');
  browser = new ManagedBrowser({
    profileDir: path.join(userData, 'browser-profile'),
    log: (m) => log?.(`[chromium-repair] ${m}`),
  });
  coordinator = new CdpCoordinator({
    log: (m) => log?.(`[chromium-repair] ${m}`),
    browser,
    guardPath: paths.vendor('page-guard.js'),
    frameBridgePath: paths.vendor('frame-bridge.js'),
    onWatch: (urls) => settings?.set(KEY_WATCHED, urls),
  });
  coordinator.setEngine(
    new GlyphEngine({
      log: (m) => log?.(`[chromium-repair] ${m}`),
    }),
  );
  // 恢复上次的开关状态
  if (settings?.get(KEY_ENABLED, false)) {
    coordinator.setEnabled(true);
  }
  return coordinator;
}

function get() {
  return coordinator;
}

/** 现在的状态 —— 界面靠它显示"已接管 / 关闭中 / 失败原因"。 */
function status() {
  if (!coordinator) {
    return { enabled: false, running: false, supported: true, injected: false, hint: '', lastError: '' };
  }
  const state = coordinator.getStatus();
  return {
    ...state,
    supported: true,
    browserClosedByUser: state.browserClosedByUser === true,
    autoReopen: coordinator.autoReopen !== false,
    // 界面把「浏览器没开」当中性状态处理；Windows 线上是**我们自己开的**浏览器，
    // 所以这里不暴露 safariRunning 那个字段（那是 mac 线的口径）。
    hint: state.enabled ? HINT_ON : '',
  };
}

/** 注册 IPC（命名遵循项目既有约定：模块:动作）。 */
function registerIpc(ipcMain, { settings } = {}) {
  ipcMain.handle('chromiumRepair:getStatus', async () => status());

  ipcMain.on('chromiumRepair:setEnabled', (_e, enabled) => {
    if (!coordinator) return;
    coordinator.setEnabled(!!enabled);
  });

  ipcMain.on('chromiumRepair:setEnabledSetting', (_e, enabled) => {
    settings?.set(KEY_ENABLED, !!enabled);
  });

  ipcMain.handle('chromiumRepair:checkNow', async () => {
    if (!coordinator) return { action: 'not-initialized' };
    return coordinator.tick();
  });

  // 用户点了「重新打开浏览器」
  ipcMain.handle('chromiumRepair:reopenBrowser', async () => {
    if (!coordinator) return { action: 'not-initialized' };
    return coordinator.reopenBrowser();
  });

  // 「关掉窗口之后要不要自动重开」
  ipcMain.handle('chromiumRepair:setAutoReopen', async (enabled) => {
    if (!coordinator) return { action: 'not-initialized' };
    return { autoReopen: coordinator.setAutoReopen(enabled) };
  });
}

function dispose() {
  try {
    coordinator?.stop();
  } catch (_) {
    /* ignore */
  }
  // 只断连接，**不关浏览器**：那个窗口现在是用户的窗口了。
  try {
    browser?.disconnect();
  } catch (_) {
    /* ignore */
  }
  coordinator = null;
  browser = null;
}

module.exports = {
  id: 'chromium-repair',
  title: '浏览器复制修复',
  init,
  get,
  registerIpc,
  dispose,
  status,
  CdpCoordinator,
};
