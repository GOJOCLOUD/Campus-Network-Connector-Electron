const { app, BrowserWindow, globalShortcut, ipcMain, clipboard, Tray, Menu } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const nacl = require('tweetnacl');
// 快捷键的 latch 状态机(纯函数,能单独测 —— 见 tools/verify/verify-shortcut-latch.cjs)。
const { createShortcutLatch } = require('./shortcut-latch.cjs');

// ── Native addon（按平台加载）──
// macOS   → mac-coregraphics（CoreGraphics：模拟点击 / 输入 / 输入源 / 录制）
// Windows → win-input（Win32：SendInput / 低级鼠标钩子）
//
// 必须**按平台加载**：加载了别的平台的模块会直接抛错，把整个主进程带崩（白屏/闪退）。
// 加载失败也必须**可见**（见 native:getStatus），不能静默 —— 见 ADR-0003。
const NATIVE_MODULES = {
  darwin: { name: 'mac-coregraphics', path: './mac-coregraphics' },
  win32: { name: 'win-input', path: './win-input' },
};
const NATIVE = NATIVE_MODULES[process.platform] || null;

let native = null;
/** 原生模块加载失败的原因（界面要显示出来 —— 静默失效比崩溃更难查） */
let nativeModuleError = '';
if (NATIVE) {
  try {
    native = require(NATIVE.path);
    if (!native || typeof native.mouseClick !== 'function') {
      throw new Error('原生模块没有导出预期的方法');
    }
  } catch (error) {
    nativeModuleError = String(error && error.message ? error.message : error);
    console.error(`[native] 加载 ${NATIVE.name} 失败:`, nativeModuleError);
    native = null;
  }
} else {
  nativeModuleError = `当前平台(${process.platform})没有可用的原生模块`;
}

/** 调用原生能力：当前平台不支持时安静返回 null，不让整个 App 崩掉。 */
function nativeCall(name, ...args) {
  if (!native || typeof native[name] !== 'function') {
    console.warn(`[native] ${name} 在当前平台(${process.platform})不可用`);
    return null;
  }
  try {
    return native[name](...args);
  } catch (error) {
    console.error(`[native] ${name} 调用失败:`, error && error.message);
    return null;
  }
}
const { loadFeatures } = require('./src/features');

// ── Paths ──
const LEGACY_BACKEND_DIR = path.join(__dirname, 'backend');
const DATA_DIR = () => path.join(app.getPath('userData'), 'data');
const RECORDINGS_DIR = () => path.join(DATA_DIR(), 'recordings');
const LEGACY_MIGRATION_MARKER_FILE = () => path.join(DATA_DIR(), '.legacy-migration-complete');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const INSTALL_ID_FILE = () => path.join(app.getPath('userData'), 'install.id');
const ACTIVATION_STATE_FILE = () => path.join(app.getPath('userData'), 'activation-state.json');
const PRIMARY_LICENSE_FILE = () => path.join(app.getPath('userData'), '.license-store');
const MIRROR_LICENSE_DIR = () => path.join(app.getPath('appData'), '.cnc-license');
const MIRROR_LICENSE_FILE = () => path.join(MIRROR_LICENSE_DIR(), '.state');
const INPUT_SOURCE_CONFIG_FILE = () => path.join(DATA_DIR(), 'input_source_config.json');
const ACTIVATION_PUBLIC_KEY_B64 = 'j5FyVLxHq1KZLNMrWYey+pfbq/wRSghcy7URZLmiYBU=';
const ACTIVATION_PRODUCT_ID = 'campus-network-connector';
const ACTIVATION_LICENSE_PREFIX = 'cs1';
const ACTIVATION_STATE_SALT = 'campus-network-connector/offline-state/v2';
const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1000;
const STATE_WRITE_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分钟写一次盘，避免每秒刷写

// ── App State ──
let mainWindow = null;
let selectedJsonSetting = '';
let pinyinTextSetting = '';
let pinyinSourcesSetting = { button: 'textbox', shortcut: 'clipboard' };
let autoSwitchImeSetting = true;
let keepaliveEnabledSetting = true;
// 各功能的设置（命名空间隔离）：features.<功能名>.<键>
// 新增功能直接往自己的命名空间里写，互不干扰。
let featureSettings = {};
/** 已加载的功能实例（由 src/features/index.js 的注册表管理） */
let features = null;
let keepaliveTimer = null;

// ── Single Instance Lock ──
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 第二次启动 = 把**已有的**窗口叫回来(而不是新开一份)。
    // `restore()` 要在 `show()` 前面:窗口是最小化状态时,
    // 光 show 不会把它从任务栏的最小化态里拉出来。
    showMainWindow();
  });
}

// ── 托盘图标 ──
//
// **关窗口只是把窗口藏起来**(进程留着,见 `mainWindow.on('close')`),
// 而 Windows 上窗口一藏,**任务栏就没有图标了** —— 没有托盘的话,
// 这个 app 就**再也找不回来**(只剩"再运行一次程序"那条路)。
//
// 托盘菜单只有两项:
// - 「显示窗口」:把藏起来的窗口叫回来(左键点托盘图标也是这个效果);
// - 「退出程序」:**彻底退出**进程。
//
// 建不出来也不能拖垮整个 app:大不了没有托盘图标,
// 用户还能靠"再运行一次程序"把窗口叫回来。
let tray = null;
/** 正在真正退出 —— 为 true 时不再拦窗口的 close(否则会把退出锁死) */
let isQuitting = false;

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * 托盘图标的真实文件路径。
 *
 * **必须是真的文件路径**,不能是 asar 里的路径 ——
 * Windows 的托盘是把图标交给系统画的(`Shell_NotifyIcon`),
 * 系统读不了 asar(那是个归档包)。
 * 所以打包时用 `extraResources` 把它放到 **asar 外面**
 * (`resources/win-icon.ico`,见 package.json 的 build.extraResources),
 * 运行时从 `process.resourcesPath` 取。
 *
 * 开发时(没打包)asar 不存在 ⇒ 退回仓库里的 `build/win-icon.ico`。
 */
function trayIconPath() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'win-icon.ico') : null,
    path.join(__dirname, 'build', 'win-icon.ico'),
  ].filter(Boolean);
  return candidates.find((p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  }) || null;
}

function createTray() {
  try {
    const iconPath = trayIconPath();
    if (!iconPath) {
      console.error('[tray] 找不到托盘图标,不装托盘(已试:', process.resourcesPath, '与', path.join(__dirname, 'build'), ')');
      return;
    }
    tray = new Tray(iconPath);
    tray.setToolTip('模拟输入');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示窗口', click: () => showMainWindow() },
      { label: '退出程序', click: () => { isQuitting = true; app.quit(); } },
    ]));
    // 左键点托盘图标 = 把窗口叫回来(用户点它就是想"看到窗口")。
    tray.on('click', () => showMainWindow());
    console.log('[tray] 托盘图标已创建:', iconPath);
  } catch (error) {
    console.error('[tray] 托盘图标创建失败(窗口照样能关,但没有托盘图标):', error);
  }
}

// ── Settings ──
function loadSettings() {
  try {
    const fp = SETTINGS_FILE();
    if (!fs.existsSync(fp)) return;
    const raw = fs.readFileSync(fp, 'utf-8');
    const data = JSON.parse(raw || '{}');
    selectedJsonSetting = String(data.selectedJson || '');
    pinyinTextSetting = String(data.pinyinText || '');
    const src = data.pinyinSources || {};
    pinyinSourcesSetting = {
      button: src.button === 'clipboard' ? 'clipboard' : 'textbox',
      shortcut: src.shortcut === 'textbox' ? 'textbox' : 'clipboard',
    };
    autoSwitchImeSetting = typeof data.autoSwitchIme === 'boolean' ? data.autoSwitchIme : true;
    keepaliveEnabledSetting = typeof data.keepaliveEnabled === 'boolean' ? data.keepaliveEnabled : true;
    // 功能设置：优先用新的 features 命名空间；旧版扁平键自动迁移过来
    featureSettings = (data.features && typeof data.features === 'object') ? { ...data.features } : {};
    if (data.safariRepairEnabled !== undefined) {
      const ns = (featureSettings['safari-repair'] = featureSettings['safari-repair'] || {});
      if (ns.enabled === undefined) ns.enabled = data.safariRepairEnabled === true;
    }
    if (Array.isArray(data.safariRepairWatched)) {
      const ns = (featureSettings['safari-repair'] = featureSettings['safari-repair'] || {});
      if (!Array.isArray(ns.watched)) ns.watched = data.safariRepairWatched.map(String);
    }
  } catch (_) {}
}

function saveSettings() {
  try {
    const fp = SETTINGS_FILE();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify({
      selectedJson: selectedJsonSetting,
      pinyinText: pinyinTextSetting,
      pinyinSources: pinyinSourcesSetting,
      autoSwitchIme: autoSwitchImeSetting,
      keepaliveEnabled: keepaliveEnabledSetting,
      features: featureSettings,
    }, null, 2), 'utf-8');
  } catch (_) {}
}

// ── Keepalive ──
function pingNetwork() {
  return new Promise((resolve) => {
    const req = http.get('https://www.baidu.com', { timeout: 5000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function startKeepalive() {
  stopKeepalive();
  keepaliveTimer = setInterval(async () => {
    if (!keepaliveEnabledSetting) return;
    await pingNetwork();
  }, 180000); // 3 分钟
}

function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

// ── Install ID ──
function getInstallId() {
  const fp = INSTALL_ID_FILE();
  if (fs.existsSync(fp)) {
    const existing = fs.readFileSync(fp, 'utf-8').trim();
    if (existing) return existing;
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, id + '\n', 'utf-8');
  return id;
}

function readLegacyActivationState() {
  try {
    const fp = ACTIVATION_STATE_FILE();
    if (!fs.existsSync(fp)) return {};
    const raw = fs.readFileSync(fp, 'utf-8');
    const data = JSON.parse(raw || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch (_) {
    return {};
  }
}

function getMachineFingerprint() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf-8' });
      const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) return `darwin:${match[1]}`;
    } else if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf-8' });
      const match = out.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
      if (match?.[1]) return `win32:${match[1].trim()}`;
    }
  } catch (_) {}
  return `fallback:${getInstallId()}`;
}

function getMachineHash() {
  return crypto.createHash('sha256').update(getMachineFingerprint()).digest('hex');
}

function getStateSigningKey(machineHash) {
  return crypto.createHash('sha256').update(`${ACTIVATION_STATE_SALT}:${machineHash}`).digest();
}

function normalizeActivationState(raw = {}) {
  return {
    installId: String(raw.installId || ''),
    deviceUuid: String(raw.deviceUuid || ''),
    machineHash: String(raw.machineHash || ''),
    trialUsed: raw.trialUsed === true,
    trialExpiresAt: Number(raw.trialExpiresAt || 0) || 0,
    license: String(raw.license || ''),
    firstSeenAt: Number(raw.firstSeenAt || 0) || 0,
    lastSeenAt: Number(raw.lastSeenAt || 0) || 0,
  };
}

function sealActivationState(state) {
  const normalized = normalizeActivationState(state);
  const payload = Buffer.from(JSON.stringify(normalized), 'utf-8');
  const mac = crypto.createHmac('sha256', getStateSigningKey(normalized.machineHash))
    .update(payload)
    .digest('hex');
  return Buffer.from(JSON.stringify({
    v: 2,
    payload: payload.toString('base64'),
    mac,
  }), 'utf-8');
}

function unsealActivationState(buffer) {
  try {
    const envelope = JSON.parse(buffer.toString('utf-8') || '{}');
    if (Number(envelope.v || 0) !== 2) return null;
    const payload = Buffer.from(String(envelope.payload || ''), 'base64');
    const state = normalizeActivationState(JSON.parse(payload.toString('utf-8') || '{}'));
    if (!state.machineHash) return null;
    const expectedMac = crypto.createHmac('sha256', getStateSigningKey(state.machineHash))
      .update(payload)
      .digest('hex');
    if (expectedMac !== String(envelope.mac || '')) return null;
    return state;
  } catch (_) {
    return null;
  }
}

function readSealedStateFile(fp) {
  try {
    if (!fs.existsSync(fp)) return null;
    return unsealActivationState(fs.readFileSync(fp));
  } catch (_) {
    return null;
  }
}

function chooseMostRestrictiveState(states) {
  const valid = states.filter(Boolean);
  if (!valid.length) return null;
  return valid.reduce((best, next) => {
    if (!best) return next;
    const seenValues = [best.firstSeenAt, next.firstSeenAt].filter(Boolean);
    return {
      ...next,
      installId: best.installId || next.installId,
      deviceUuid: best.deviceUuid || next.deviceUuid,
      machineHash: best.machineHash || next.machineHash,
      trialUsed: best.trialUsed || next.trialUsed,
      trialExpiresAt: Math.max(best.trialExpiresAt || 0, next.trialExpiresAt || 0),
      license: best.license || next.license,
      firstSeenAt: seenValues.length ? Math.min(...seenValues) : 0,
      lastSeenAt: Math.max(best.lastSeenAt || 0, next.lastSeenAt || 0),
    };
  }, null);
}

function readActivationState() {
  const sealed = chooseMostRestrictiveState([
    readSealedStateFile(PRIMARY_LICENSE_FILE()),
    readSealedStateFile(MIRROR_LICENSE_FILE()),
  ]);
  if (sealed) return sealed;
  return normalizeActivationState(readLegacyActivationState());
}

function writeActivationState(nextState) {
  const normalized = normalizeActivationState(nextState);
  const sealed = sealActivationState(normalized);
  fs.mkdirSync(path.dirname(PRIMARY_LICENSE_FILE()), { recursive: true });
  fs.mkdirSync(MIRROR_LICENSE_DIR(), { recursive: true });
  fs.writeFileSync(PRIMARY_LICENSE_FILE(), sealed);
  fs.writeFileSync(MIRROR_LICENSE_FILE(), sealed);
  try {
    if (fs.existsSync(ACTIVATION_STATE_FILE())) fs.unlinkSync(ACTIVATION_STATE_FILE());
  } catch (_) {}
  try {
    const plainMirror = path.join(MIRROR_LICENSE_DIR(), '.state.plain');
    if (fs.existsSync(plainMirror)) fs.unlinkSync(plainMirror);
  } catch (_) {}
}

function getActivationSnapshot() {
  const state = readActivationState();
  const now = Date.now();
  const machineHash = getMachineHash();
  let dirty = false;
  if (!state.deviceUuid) {
    state.deviceUuid = crypto.randomUUID();
    dirty = true;
  }
  if (!state.installId) {
    state.installId = getInstallId();
    dirty = true;
  }
  if (!state.machineHash) {
    state.machineHash = machineHash;
    dirty = true;
  }
  if (!state.firstSeenAt) {
    state.firstSeenAt = now;
    dirty = true;
  }
  const clockRollbackDetected = state.lastSeenAt > 0 && now + CLOCK_ROLLBACK_TOLERANCE_MS < state.lastSeenAt;
  if (clockRollbackDetected && !state.trialUsed) {
    state.trialUsed = true;
    state.trialExpiresAt = 0;
    dirty = true;
  }
  if (state.machineHash !== machineHash) {
    state.trialUsed = true;
    state.trialExpiresAt = 0;
    dirty = true;
  }
  if (now - state.lastSeenAt >= STATE_WRITE_INTERVAL_MS) {
    state.lastSeenAt = now;
    dirty = true;
  }
  if (dirty) writeActivationState(state);
  const snapshot = {
    installId: String(state.installId || ''),
    deviceUuid: String(state.deviceUuid || ''),
    machineHash: String(state.machineHash || ''),
    trialUsed: state.trialUsed === true,
    trialExpiresAt: Number(state.trialExpiresAt || 0) || 0,
    license: String(state.license || ''),
    firstSeenAt: Number(state.firstSeenAt || 0) || 0,
    lastSeenAt: Number(state.lastSeenAt || 0) || 0,
    clockRollbackDetected,
  };
  snapshot.licenseValid = snapshot.license
    ? verifyLicenseForDevice(snapshot.license, snapshot.deviceUuid).ok
    : false;
  return snapshot;
}

function updateActivationState(patch) {
  const snapshot = getActivationSnapshot();
  const current = {
    installId: snapshot.installId,
    deviceUuid: snapshot.deviceUuid,
    trialUsed: snapshot.trialUsed,
    trialExpiresAt: snapshot.trialExpiresAt,
    license: snapshot.license,
    machineHash: snapshot.machineHash,
    firstSeenAt: snapshot.firstSeenAt,
    lastSeenAt: snapshot.lastSeenAt,
  };
  const next = { ...current, ...patch };
  writeActivationState(next);
  return getActivationSnapshot();
}

function b64urlToBuffer(value) {
  const normalized = String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64');
}

function normalizeUuidForLicense(uuid) {
  const raw = String(uuid || '').trim();
  if (!raw) throw new Error('UUID 不能为空');
  const hexOnly = raw.replace(/[^a-fA-F0-9]/g, '');
  if (hexOnly.length >= 24) return hexOnly.slice(0, 24).toLowerCase();
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function verifyLicenseForDevice(license, deviceUuid) {
  const parts = String(license || '').trim().split('.');
  if (parts.length !== 3) return { ok: false, error: '激活码格式不正确' };
  const [prefix, payloadB64Url, sigB64Url] = parts;
  if (prefix !== ACTIVATION_LICENSE_PREFIX) {
    return { ok: false, error: `激活码前缀不匹配（期望 ${ACTIVATION_LICENSE_PREFIX}）` };
  }
  let payloadBytes;
  let sigBytes;
  try {
    payloadBytes = b64urlToBuffer(payloadB64Url);
    sigBytes = b64urlToBuffer(sigB64Url);
  } catch (_) {
    return { ok: false, error: '激活码内容无法解析' };
  }
  const publicKey = Buffer.from(ACTIVATION_PUBLIC_KEY_B64, 'base64');
  if (!nacl.sign.detached.verify(payloadBytes, sigBytes, publicKey)) {
    return { ok: false, error: '激活码校验失败：签名不合法' };
  }
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf-8') || '{}');
  } catch (_) {
    return { ok: false, error: '激活码 payload 不是有效 JSON' };
  }
  if (Number(payload?.v || 0) !== 1) return { ok: false, error: '激活码版本不支持' };
  if (String(payload?.product || '') !== ACTIVATION_PRODUCT_ID) {
    return { ok: false, error: '激活码 product 不匹配' };
  }
  if (String(payload?.device || '') !== normalizeUuidForLicense(deviceUuid)) {
    return { ok: false, error: '激活码设备不匹配' };
  }
  return { ok: true };
}

// ── Input Source Config ──
function readInputSourceConfig() {
  try {
    if (fs.existsSync(INPUT_SOURCE_CONFIG_FILE())) {
      return JSON.parse(fs.readFileSync(INPUT_SOURCE_CONFIG_FILE(), 'utf-8') || '{}');
    }
  } catch (_) {}
  return {};
}

function writeInputSourceConfig(config) {
  try {
    fs.mkdirSync(DATA_DIR(), { recursive: true });
    fs.writeFileSync(INPUT_SOURCE_CONFIG_FILE(), JSON.stringify(config, null, 2), 'utf-8');
  } catch (_) {}
}

// ── File Management ──
function migrateLegacyDataFiles() {
  try {
    fs.mkdirSync(RECORDINGS_DIR(), { recursive: true });
    if (fs.existsSync(LEGACY_MIGRATION_MARKER_FILE())) return;
    if (!fs.existsSync(LEGACY_BACKEND_DIR)) return;

    for (const name of fs.readdirSync(LEGACY_BACKEND_DIR)) {
      const src = path.join(LEGACY_BACKEND_DIR, name);
      if (name === 'input_source_config.json') {
        if (!fs.existsSync(INPUT_SOURCE_CONFIG_FILE())) {
          fs.mkdirSync(DATA_DIR(), { recursive: true });
          fs.copyFileSync(src, INPUT_SOURCE_CONFIG_FILE());
        }
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const dest = path.join(RECORDINGS_DIR(), name);
      if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    }
    fs.mkdirSync(DATA_DIR(), { recursive: true });
    fs.writeFileSync(LEGACY_MIGRATION_MARKER_FILE(), new Date().toISOString(), 'utf-8');
  } catch (e) {
    console.error('[data] migration failed:', e);
  }
}

function listClickFiles() {
  try {
    migrateLegacyDataFiles();
    if (!fs.existsSync(RECORDINGS_DIR())) return [];
    return fs.readdirSync(RECORDINGS_DIR())
      .filter(f => f.endsWith('.json'))
      .sort()
      .map((name, i) => ({ id: i + 1, name }));
  } catch (_) { return []; }
}

function getNextRecordingFileName() {
  const nums = listClickFiles()
    .map(({ name }) => {
      const match = String(name || '').match(/^点击_?(\d+)\.json$/);
      return match ? Number(match[1]) : 0;
    })
    .filter(n => Number.isFinite(n) && n > 0);
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `点击${next}.json`;
}

// ── Playback / Input — helper: spawn worker via subprocess ──
// We run clicks/text injection in the main process synchronously so there
// is no subprocess/Accessibility-permission-split issue.
// For long playback we use a timeout to keep UI responsive.

function sleepMs(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Playback safety(重入保护)──
//
// 2026-10-23 T0 事故:回放时发出的**合成点击**如果落在 App 自己的窗口上,
// 就会点到自己界面上的「默认执行」→ 又一次回放 → 合成点击又点自己 →
// **无限自激循环** → 疯狂敲键盘 → 整台机器卡死(用户被迫强制关机)。
//
// 这条分支只上**闸 ①(重入保护)**:同一时刻最多一个回放,后来的直接拒绝。
// (闸 ②「落点在自己窗口上的点击不发出去」依赖坐标系,Windows 线暂不启用,
//  理由见 `playback-guard.cjs` 的说明。)
//
// ⚠️ 这道闸不能去掉。少了它,一次误触就能把用户的机器搞死。
const { createPlaybackGuard } = require('./playback-guard.cjs');
const playbackGuard = createPlaybackGuard();

// 闸的**入口检查**:起回放之前同步问一次,好让界面立刻知道"被拒绝了"。
function playbackBusy() {
  return playbackGuard.isBusy();
}

// 回放期间让窗口**穿透**(不接收鼠标事件),返回有没有成功。
//
// ## 为什么必须有它
//
// App 的窗口是 always-on-top 的小面板,**常常正好盖在目标网站的输入框上面**。
// 回放要点击的位置如果落在自己窗口上:
// - 不穿透 ⇒ 那个点击变成**点自己** ⇒ 点中自己的「默认执行」⇒ 又一次回放
//   ⇒ **无限自激循环**(2026-10-23 T0)⇒ 疯狂键入 ⇒ 机器卡死。
//
// 穿透成功 ⇒ 点击**正常落到下面的应用** ⇒ 既不自激,回放也完整。
function setWindowPassthrough(ignore) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
    return true;
  } catch (_) {
    return false;
  }
}

async function playClicks(clicks, interval, inputs) {
  const perClickInputs = Array.isArray(inputs)
    ? inputs.map(i => (i && String(i).trim()) ? String(i).trim() : null)
    : null;

  // 闸 ①:重入保护 —— 已经在放就直接拒绝,不并行起第二个回放。
  if (!playbackGuard.tryStart()) {
    console.error(`[playback] 上一次回放还没结束,这次没有重复执行(已拒绝 ${playbackGuard.rejectedCount()} 次)`);
    return { executed: 0, skipped: 0, rejected: true };
  }
  // **窗口穿透**:回放期间让窗口不接收鼠标事件,
  // 这样回放的点击能落到下面的目标应用上(见 setWindowPassthrough 的说明)。
  //
  // ⚠️ 穿透失败时**没有**兜底的「跳过自己窗口上的点击」(mac 侧的闸②)——
  //   Windows 的 `SendInput` 用绝对屏幕坐标,和窗口 bounds 的量纲在缩放下对不上,
  //   没核实之前不能开(理由见 `playback-guard.cjs` 的说明)。
  //   这里把结果**记进日志** —— 不然"穿透没成功"在排障时完全看不见。
  const penetrated = setWindowPassthrough(true);
  if (!penetrated) {
    console.warn('[playback] 窗口穿透没成功 —— 合成点击可能落在自己的界面上(闸②在 Windows 上未启用,见 playback-guard.cjs)');
  }
  let executed = 0;
  // 第一次失败的原因(与 mac / Tauri 版同口径:记第一个错误,但**继续往下走**)。
  let error = '';
  try {
    for (let i = 0; i < clicks.length; i++) {
      const c = clicks[i];
      // **发不出去就不算执行**(与 mac / Tauri 版同口径)。
      //
      // Windows 上 `SendInput` 被系统拦下时(目标窗口权限更高、锁屏、
      // 会话切换),原生层会返回 false ⇒ 屏幕上什么都没发生 ——
      // 那种情况下把它计成"执行了"就是骗人(用户看到计数在涨,却什么都没发生)。
      const sent = nativeCall('mouseClick', c.x, c.y);
      if (!sent) {
        if (!error) {
          error = '模拟点击发不出去(可能是目标窗口权限更高,或系统正处于锁屏/会话切换状态)';
        }
      } else {
        executed += 1;
      }
      await sleepMs(100);

      if (perClickInputs && perClickInputs[i]) {
        await sleepMs(100);
        if (!nativeCall('sendText', perClickInputs[i]) && !error) {
          error = '键入文本发不出去(可能没有前台窗口,或目标窗口权限更高)';
        }
      }

      if (i < clicks.length - 1) {
        await sleepMs(Math.max(50, interval * 1000));
      }
    }
  } finally {
    // 窗口恢复可点 —— 不恢复的话,用户会以为界面坏了。
    setWindowPassthrough(false);
    // 哪怕中途抛错,也要把闸放开,否则回放再也起不来。
    playbackGuard.finish();
  }
  return { executed, skipped: 0, rejected: false, error };
}

async function pinyinType(text, delaySeconds = 3, autoSwitchIme = false) {
  if (text.length === 0) return;

  if (autoSwitchIme) {
    // Switch to ASCII input source if configured
    const config = readInputSourceConfig();
    if (config.ascii_id) {
      nativeCall('selectInputSource', config.ascii_id);
    }
    await sleepMs(300);
  }

  if (delaySeconds > 0) {
    await sleepMs(delaySeconds * 1000);
  }

  nativeCall('sendText', text);
}

// ── IPC Handlers ──

// Window controls (unchanged)
ipcMain.handle('window:quit', () => app.quit());
ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
// 关窗口,但**进程留着**(Windows 线的「后台挂着」)。
//
// 和 macOS 的红绿灯同口径:窗口只是**藏起来**,进程还在跑,
// 托盘图标也还在 ⇒ 还能把窗口叫回来。
// 彻底退出走**托盘菜单里的「退出程序」**。
ipcMain.handle('window:hide', () => { if (mainWindow) mainWindow.hide(); });

// Settings (unchanged)
ipcMain.on('settings:setSelectedJson', (_e, fileName) => {
  selectedJsonSetting = String(fileName || '');
  saveSettings();
});
ipcMain.handle('settings:getSelectedJson', async () => selectedJsonSetting);
ipcMain.on('settings:setPinyinText', (_e, text) => {
  pinyinTextSetting = String(text || '');
  saveSettings();
});
ipcMain.on('settings:setPinyinSources', (_e, sources) => {
  const s = sources || {};
  pinyinSourcesSetting = {
    button: s.button === 'clipboard' ? 'clipboard' : 'textbox',
    shortcut: s.shortcut === 'textbox' ? 'textbox' : 'clipboard',
  };
  saveSettings();
});
ipcMain.on('settings:setAutoSwitchIme', (_e, enabled) => {
  autoSwitchImeSetting = !!enabled;
  saveSettings();
});

// Keepalive
ipcMain.handle('keepalive:getStatus', async () => keepaliveEnabledSetting);

ipcMain.on('keepalive:setEnabled', (_e, enabled) => {
  keepaliveEnabledSetting = !!enabled;
  saveSettings();
});

// Activation
ipcMain.handle('activation:getSnapshot', async () => getActivationSnapshot());
ipcMain.handle('activation:startTrial', async (_e, expiresAt) => {
  const nextExpiry = Number(expiresAt || 0) || 0;
  if (nextExpiry <= Date.now()) {
    throw new Error('试用过期时间无效');
  }
  const current = getActivationSnapshot();
  if (current.trialUsed) return current;
  return updateActivationState({
    trialUsed: true,
    trialExpiresAt: nextExpiry,
  });
});
ipcMain.handle('activation:saveLicense', async (_e, license) => {
  const current = getActivationSnapshot();
  const result = verifyLicenseForDevice(license, current.deviceUuid);
  if (!result.ok) return result;
  updateActivationState({ license: String(license || '') });
  return { ok: true };
});
ipcMain.handle('activation:clearLicense', async () => {
  return updateActivationState({ license: '' });
});
ipcMain.handle('activation:migrateLegacy', async (_e, legacy) => {
  const current = getActivationSnapshot();
  if (current.trialUsed || current.trialExpiresAt || current.license) return current;
  const data = legacy && typeof legacy === 'object' ? legacy : {};
  return updateActivationState({
    deviceUuid: String(data.deviceUuid || current.deviceUuid),
    trialUsed: data.trialUsed === true,
    trialExpiresAt: Number(data.trialExpiresAt || 0) || 0,
    license: String(data.license || ''),
  });
});

// Mouse click
/** 原生模块状态：界面据此提示"模拟输入不可用"，而不是让按钮静默失灵 */
ipcMain.handle('native:getStatus', async () => ({
  ok: !!native,
  error: nativeModuleError,
  platform: process.platform,
  // 快捷键与 latch 的诊断字段(与 mac 分支的 `[shortcut]` 日志同口径)。
  //
  // Windows 线**抢 ⌃D**(读剪贴板并键入),**不抢 ⌃S** —— 理由见
  // `GLOBAL_SHORTCUTS_ENABLED` 的注释。
  // ⇒ `shortcutCtrlD` = ⌃D 注册成功没有;`globalShortcutsEnabled` = 全局键这条路
  // 是**开着**的;`shortcutPasteRegistered` = **抢到了没有**(界面靠它显示提示)。
  shortcutCtrlS: shortcutStatus.ctrlS,
  shortcutCtrlD: shortcutStatus.ctrlD,
  latchAvailable: shortcutStatus.latchAvailable,
  latchArmed: shortcutStatus.latchArmed,
  controlWatcherRunning: shortcutStatus.controlWatcherRunning,
  globalShortcutsEnabled: GLOBAL_SHORTCUTS_ENABLED,
  // ⌃D **抢到了没有** —— 界面要用它显示提示。
  //
  // 抢不到 = 别的软件先注册了同一个组合键 ⇒
  // 我们的 ⌃D **不会触发**,而目标软件自己的 Ctrl+D 也**照常生效**
  // (所以那个软件还是会被它的「退出」关掉)⇒ 必须让用户知道。
  shortcutPasteRegistered: shortcutStatus.ctrlD === true,
}));

ipcMain.handle('native:mouseClick', async (_e, x, y) => {
  return nativeCall('mouseClick', x, y);
});

// Mouse position
ipcMain.handle('native:mouseGetPosition', async () => {
  return nativeCall('mouseGetPosition', );
});

// Send text
ipcMain.handle('native:sendText', async (_e, text) => {
  return nativeCall('sendText', String(text || ''));
});

// Send key
ipcMain.handle('native:sendKey', async (_e, keyCode, flags) => {
  return nativeCall('sendKey', keyCode, flags || 0);
});

// Input source
ipcMain.handle('native:getCurrentInputSource', async () => {
  return nativeCall('getCurrentInputSource', );
});

ipcMain.handle('native:selectInputSource', async (_e, sourceId) => {
  return nativeCall('selectInputSource', String(sourceId || ''));
});

// Input source config (saved in backend/input_source_config.json)
ipcMain.handle('native:getInputSourceConfig', async () => {
  return readInputSourceConfig();
});

ipcMain.handle('native:saveInputSourceConfig', async (_e, config) => {
  const current = readInputSourceConfig();
  if (config.ascii_id !== undefined) current.ascii_id = String(config.ascii_id || '');
  if (config.pinyin_id !== undefined) current.pinyin_id = String(config.pinyin_id || '');
  if (config.switch_shortcut !== undefined) current.switch_shortcut = String(config.switch_shortcut || 'cmd+space');
  writeInputSourceConfig(current);
  return current;
});

ipcMain.handle('native:setCurrentAsInputSource', async (_e, role) => {
  const info = nativeCall('getCurrentInputSource', );
  if (!info.id) return { status: 'error', message: '无法读取当前输入源 ID' };
  const config = readInputSourceConfig();
  if (role === 'ascii') config.ascii_id = info.id;
  else if (role === 'pinyin') config.pinyin_id = info.id;
  else return { status: 'error', message: '未知角色' };
  writeInputSourceConfig(config);
  return { status: 'success', message: '已保存', ...config };
});

// Recording

// 自己窗口在屏幕上的范围(左、上、右、下)—— 主进程手里的是**权威值**。
//
// 「点自己界面上的按钮不算一次点击」靠它实现:落在自己窗口范围内的点击不记。
function ownWindowRect() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const b = mainWindow.getBounds();
    return [b.x, b.y, b.x + b.width, b.y + b.height];
  } catch (_) {
    return null;
  }
}

ipcMain.handle('native:startRecording', async () => {
  try {
    // 排除矩形用**主进程**的窗口位置算(权威值),不采信渲染进程传过来的那份:
    // 渲染进程那份是「开始录制那一刻」的快照,窗口一动就过期
    // ⇒ 点「结束」会被记成一次点击(用户 2026-10-23 报过的 bug)。
    // 所以前端**不传**矩形。
    const rect = ownWindowRect();
    nativeCall('startRecording', rect || []);
    return true;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('native:stopRecording', async () => {
  nativeCall('stopRecording', );
  // **不清空**:录到的点击还要留着给「单条删除」用
  // (界面上删一条,这里也得跟着删一条,两边才对得上)。
  const clicks = nativeCall('getRecordingClicks', );
  // null = 失败,界面据此保留原来的记录,不清空。
  return Array.isArray(clicks) ? clicks : null;
});

ipcMain.handle('native:getRecordingClicks', async () => {
  return nativeCall('getRecordingClicks', );
});

ipcMain.handle('native:clearRecordingClicks', async () => {
  nativeCall('clearRecordingClicks', );
  return true;
});

// 删掉第 index 次点击(单条删除)
ipcMain.handle('native:removeRecordingClick', async (_e, index) => {
  return nativeCall('removeRecordingClick', Number(index) || 0) === true;
});

ipcMain.handle('native:isRecording', async () => {
  return nativeCall('isRecording', );
});

ipcMain.handle('native:tapFailed', async () => {
  return nativeCall('tapFailed', );
});

// File management
ipcMain.handle('file:listFiles', async () => {
  return listClickFiles();
});

ipcMain.handle('file:saveFile', async (_e, clicks, filename) => {
  try {
    fs.mkdirSync(RECORDINGS_DIR(), { recursive: true });
    let name = filename;
    if (!name || !name.endsWith('.json')) {
      name = getNextRecordingFileName();
    }
    const data = {
      start_time: new Date().toISOString(),
      click_count: clicks.length,
      clicks,
    };
    fs.writeFileSync(path.join(RECORDINGS_DIR(), name), JSON.stringify(data, null, 2), 'utf-8');
    return { status: 'success', file: name };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('file:renameFile', async (_e, oldName, newName) => {
  try {
    let nn = newName;
    if (!nn.endsWith('.json')) nn += '.json';
    fs.renameSync(path.join(RECORDINGS_DIR(), oldName), path.join(RECORDINGS_DIR(), nn));
    return { status: 'success' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('file:deleteFile', async (_e, filename) => {
  try {
    fs.unlinkSync(path.join(RECORDINGS_DIR(), filename));
    return { status: 'success' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('file:readFile', async (_e, filename) => {
  try {
    const data = fs.readFileSync(path.join(RECORDINGS_DIR(), filename), 'utf-8');
    return JSON.parse(data);
  } catch (_) {
    return null;
  }
});

// Playback (runs asynchronously)
ipcMain.handle('play:playFile', async (_e, fileName, interval, inputText) => {
  try {
    if (playbackBusy()) {
      return { status: 'error', message: '上一次回放还没结束,这次没有重复执行' };
    }
    const filePath = path.join(RECORDINGS_DIR(), fileName);
    if (!fs.existsSync(filePath)) return { status: 'error', message: '文件不存在' };
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const clicks = data.clicks || [];

    // Check per-click input_text first
    const perClick = clicks.map(c => c.input_text || null);
    const hasPerClick = perClick.some(t => t !== null);
    const inputs = hasPerClick ? perClick : (inputText ? [inputText] : null);

    playClicks(clicks, interval || 0.5, inputs).catch(e => console.error('[play] error:', e));
    return { status: 'success', message: '开始执行' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('play:playData', async (_e, clicks, interval) => {
  try {
    if (playbackBusy()) {
      return { status: 'error', message: '上一次回放还没结束,这次没有重复执行' };
    }
    playClicks(clicks || [], interval || 0.5, null).catch(e => console.error('[play] error:', e));
    return { status: 'success' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('play:pinyinInput', async (_e, text, delaySeconds, autoSwitchIme) => {
  pinyinType(text || '', delaySeconds, autoSwitchIme).catch(e => console.error('[pinyin] error:', e));
  return { status: 'success', message: `将在 ${delaySeconds || 3} 秒后开始输入` };
});

// ── Window Creation ──

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 640,
    // 去掉 macOS 自带的标题栏,但**保留原生红绿灯**,并把它挪到左上角那片透明区:
    //   titleBarStyle:'hidden' —— 标题栏隐藏,红绿灯浮在内容上(原生按钮,行为完全正常)
    //   trafficLightPosition  —— 红绿灯的位置
    // Windows/Linux 没有原生红绿灯 → frame:false,改用页面上自绘的 ✕。
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 12 } }
      : { frame: false }),
    transparent: true,
    backgroundColor: '#00000000',
    // 透明窗口上的原生阴影是一个方的框,叠在卡片下面会变成一整块深色;
    // 阴影交给卡片自己的 shadow-md。
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  // 录制用的「排除矩形」必须**跟着窗口走**。
  //
  // 「点自己界面上的按钮不算一次点击」靠它实现:落在自己窗口范围内的点击不记。
  // 矩形不能只在开始录制时拍一张快照 —— 窗口一动快照就过期了,点「结束」
  // 会被当成一次外部点击(用户 2026-10-23 报过的 bug)。所以窗口**每次移动/变高**
  // 都刷新一次。
  const refreshExcludeRect = () => {
    const rect = ownWindowRect();
    if (!rect) return;
    nativeCall('setExcludeRect', rect);
  };
  mainWindow.on('move', refreshExcludeRect);
  mainWindow.on('resize', refreshExcludeRect);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // **关窗口 ≠ 退出 App**(2026-10-24 用户口径:
  // 「你不能点叉,他就直接完全退出了,这个他要在后台挂着,功能依然生效」)。
  //
  // Windows 上直接退进程 = 把 app **关掉了**(不是"收起来")。
  // 这里改成**只隐藏窗口**:进程留着 ⇒ 托盘图标还在,还能把窗口叫回来。
  // 彻底退出有两个入口:右上角「关闭软件」按钮(`window:quit`)
  // 或托盘菜单的「退出程序」。
  //
  // macOS 保持原样(红绿灯关窗口,App 留在 Dock,`activate` 再开一个)。
  mainWindow.on('close', (event) => {
    if (isQuitting) return;                 // 正在退出 → 放行(别把退出锁死)
    if (process.platform === 'darwin') return;
    event.preventDefault();
    mainWindow.hide();
  });

  const indexPath = path.join(__dirname, 'dist', 'index.html');
  console.log(`[main] loading ${indexPath}`);
  mainWindow.loadFile(indexPath);

  return mainWindow;
}

// ── Shortcuts ──

// Windows 线**要不要注册全局快捷键**。
//
// ## 开着,而且**只抢 ⌃D**(2026-10-24 用户口径)
//
// 用户原话:「干脆直接把系统的抢了,我的软件优先级最高,这是最简单的办法,
// 因为 Ctrl 加 D 我发现在普通桌面它是退出软件的功能,那在使用这个的时候
// 没必要退出吧,所以说我就给他压制住」。
//
// - **抢 ⌃D(读剪贴板并键入)**:在普通 Windows 软件里,Ctrl+D 常常是
//   「**退出软件**」那一族动作(菜单加速键)。我们自己注册成全局热键,
//   别的软件就**收不到**它 ⇒ 模拟输入时按到它,那个软件**不会被关掉**。
//
//   能不能真抢到,取决于**谁先注册**:
//   - 对方是**菜单加速键**(绝大多数软件的「退出」都是)⇒ 我们的
//     `globalShortcut.register` 会**先于**它生效 ⇒ 稳赢;
//   - 对方也注册了同一个组合键且**先注册** ⇒ 抢不到(系统不会让两个进程
//     同时拥有同一个组合键)。
//   ⇒ 所以「**抢没抢到必须告诉你**」:抢不到时界面要显示出来,
//   不能让你以为「按了没反应」是系统的问题(见 `native:getStatus` 的
//   `shortcutPasteRegistered` 与界面上的提示)。
//
// - **⌃S 不抢**:它驱动的是「默认执行(回放)」,而那一屏在 Windows 上
//   **已经没有界面了**(ADR-0016)⇒ 抢了也没有东西可触发;
//   而 Ctrl+S 在别的软件里是「**保存**」,抢过来会把人家的保存弄坏。
const GLOBAL_SHORTCUTS_ENABLED = true;

// 快捷键与 latch 的**诊断状态**。
//
// 「Windows 上快捷键没反应」的排查路径就靠这三个字段(见 docs/05-运维/故障排查.md):
// ① 快捷键**注册**成功没有(被别的 App 抢走就是 false);
// ② latch 当前**是不是武装**的(锁着就触发不了);
// ③ Control 只读**观察器**在不在跑(不跑 ⇒ latch 根本解不开)。
const shortcutStatus = {
  /** ⌃S(默认执行 = 回放)注册成功没有 */
  ctrlS: false,
  /** ⌃D(剪贴板直输)注册成功没有 */
  ctrlD: false,
  /** latch 可用吗(= Control 只读观察器起来了没有) */
  latchAvailable: false,
  /** 当前是不是武装的(诊断用) */
  latchArmed: true,
  /** Control 观察器线程在不在跑 */
  controlWatcherRunning: false,
};

// 「默认执行(回放)」的**实现本体**。
//
// ⚠️ **Windows 线上它现在没有入口**:⌃S **不抢**(Ctrl+S 在别的软件里是「保存」,
// 抢过来会把人家的保存弄坏 —— 理由见 `GLOBAL_SHORTCUTS_ENABLED` 的注释),
// 而「默认执行」那一屏在 Windows 上也**早就撤了**(ADR-0016)。
// ⇒ 函数**留着**:将来真要加回 ⌃S,注册它就行,不用从头写。
//
// eslint 会报「定义了没用到」—— 这是**故意**的,不是漏网。
// eslint-disable-next-line no-unused-vars
async function triggerDefaultExecute() {
  let fileName = (selectedJsonSetting || '').trim();
  if (!fileName) {
    const files = listClickFiles();
    if (!files.length) return;
    fileName = [...files].sort((a, b) => (a.name < b.name ? 1 : -1))[0].name;
  }

  const filePath = path.join(RECORDINGS_DIR(), fileName);
  if (!fs.existsSync(filePath)) return;

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const clicks = data.clicks || [];
    const perClick = clicks.map(c => c.input_text || null);
    const hasPerClick = perClick.some(t => t !== null);
    const inputs = hasPerClick ? perClick : null;
    await playClicks(clicks, 0.5, inputs);
  } catch (e) {
    console.error('[trigger] play error:', e);
  }
}

async function triggerPinyinFromClipboard() {
  const source = pinyinSourcesSetting?.shortcut === 'textbox' ? 'textbox' : 'clipboard';
  const t = (source === 'textbox' ? pinyinTextSetting : clipboard.readText() || '').trim();
  if (!t) return;

  // **Windows 不切输入源**:那边没有「输入源」这回事 ——
  // `win-input` 的 `sendText` 直接送 Unicode(WM_CHAR / KEYEVENTF_UNICODE),
  // 切输入源不但没必要,还会把用户正在用的输入法状态搅乱。
  // macOS 那边才需要切到 ASCII 输入源再送(拼音键入靠的是 ASCII 布局)。
  //
  // 其余流程(读剪贴板 / textbox 来源 / 空文本处理)与 mac 侧**同构**。
  const autoSwitch = process.platform === 'darwin' ? !!autoSwitchImeSetting : false;

  console.log(`[shortcut] ⌃D 直输:来源=${source} 长度=${t.length} 切输入源=${autoSwitch}`);
  await pinyinType(t, 0, autoSwitch);
}

function registerShortcuts() {
  if (!GLOBAL_SHORTCUTS_ENABLED) {
    // 开关关着:一个全局键都不占。
    // 诊断字段(`shortcutCtrlS` / `shortcutCtrlD` / `latchAvailable` …)保留原样:
    // 它们现在是"恒为 false / 不适用",配合 `native:getStatus` 里的
    // `globalShortcutsEnabled` 能一眼看出是**按政策不注册**。
    shortcutStatus.ctrlS = false;
    shortcutStatus.ctrlD = false;
    shortcutStatus.latchAvailable = false;
    shortcutStatus.latchArmed = false;
    shortcutStatus.controlWatcherRunning = false;
    console.log('[shortcut] Windows 线不注册任何全局快捷键');
    return;
  }

  // ── 下面这条是「真的注册全局键」的路 ──
  //
  // 快捷键:**⌃D** = 读剪贴板并键入(我们抢的就是它,理由见
  // `GLOBAL_SHORTCUTS_ENABLED` 的注释)。
  //
  // ⌃S(默认执行)**不注册**:Windows 上那一屏已经没有界面了,
  // 而 Ctrl+S 在别的软件里是「保存」,抢过来会把人家的保存弄坏。
  //
  // ## latch(2026-10-23 用户要求)
  //
  // > 「触发之后 Ctrl+D 整个按键就不再会继续影响它了,
  // > 除非下一次重新按住 Ctrl,再点击相应的字母」
  //
  // `globalShortcut` **只在按下时回调**,不告诉你 Control 什么时候松开 ⇒
  // 靠它自己解不开 latch(按住 Ctrl 连按会连着触发 ⇒ 剪贴板被键入好几遍)。
  // 所以另开一个**只读**观察看 Control 的按下/松开边沿:Control 一松开就重新武装。
  //
  // ## 规则(**Tauri 版 / mac 版同口径**;见 ADR-0013)
  //
  // - 触发 ⇒ `armed = false` 且 `blocked = true`;
  // - **Control 松开** ⇒ `blocked = false`、`armed = true`(彻底解锁);
  // - Control 按下 ⇒ **只有 `blocked == false` 时**才武装。
  //
  // 最后一条是关键:系统热键的回调和只读观察的回调**谁先到不确定**。
  // 如果「Control 按下」那一下能把 latch 解开,用户按住 Ctrl 连按会连着
  // 触发。
  //
  // ## Windows 上的只读观察怎么来的
  //
  // `win-input` 的 `watchControlKey`:用 `GetAsyncKeyState(VK_CONTROL)` 轮询
  // (25ms 一次)**做边沿检测**。选它而不是低级键盘钩子的理由见
  // `win-input/src/main.cc` 的注释:读的是**物理键盘状态**,
  // **不受 `RegisterHotKey` 影响** ⇒ 组合键被别的程序抢走也照样拿得到边沿;
  // 也没有 `WH_KEYBOARD_LL` 的 LowLevelHooksTimeout 风险(丢一次边沿 = latch 解不开)。
  //
  // 拿不到观察源时**如实降级**(`latch=false` + 打 warn),
  // **不要假装 latch 生效了**。
  //
  // 状态机本身在 `shortcut-latch.cjs`(纯函数)—— 与 Tauri 版 `Latch` 同口径,
  // 回归测试见 `tools/verify/verify-shortcut-latch.cjs`。
  const latch = createShortcutLatch();
  const watched = nativeCall('watchControlKey', (ctrlDown) => {
    latch.onCtrlChange(ctrlDown);
    shortcutStatus.latchArmed = latch.isArmed();
  });
  const canLatch = watched === true;
  if (!canLatch) {
    console.warn('[shortcut] 拿不到 Control 按下/松开的只读观察 ⇒ latch 不可用(按住 Ctrl 连按会连着触发)');
  }

  const fire = (fn, name) => () => {
    // 锁着 ⇒ 不触发(canLatch 为 false 时压根不碰 latch,维持旧行为)。
    if (canLatch && !latch.tryFire()) {
      shortcutStatus.latchArmed = latch.isArmed();
      return;
    }
    shortcutStatus.latchArmed = latch.isArmed();
    fn().catch(e => console.error(`[shortcut] ${name} failed`, e));
  };

  // **只注册 ⌃D**。抢没抢到看返回值:抢不到 ⇒ 别的软件先注册了同一个组合键
  // ⇒ 界面要把这件事显示出来(见 `native:getStatus` 的 `shortcutPasteRegistered`)。
  const okD = globalShortcut.register('Ctrl+D', fire(triggerPinyinFromClipboard, 'pinyin'));
  if (okD !== true) {
    console.warn('[shortcut] ⌃D 没抢到(这个组合键被别的软件先注册了):'
      + '按它不会触发我们,目标软件自己的 Ctrl+D 也会照常生效。');
  }

  shortcutStatus.ctrlS = false;
  shortcutStatus.ctrlD = okD === true;
  shortcutStatus.latchAvailable = canLatch;
  shortcutStatus.latchArmed = latch.isArmed();
  shortcutStatus.controlWatcherRunning = canLatch;

  console.log(`[shortcut] Ctrl+D=${okD} latch=${canLatch}`);
}

// ── App Lifecycle ──

app.on('ready', () => {
  migrateLegacyDataFiles();
  loadSettings();
  createWindow();
  registerShortcuts();
  // Windows:装**托盘图标** —— 窗口被隐藏之后靠它叫回来 / 彻底退出。
  if (process.platform === 'win32') createTray();
  startKeepalive();
  initFeatures();
});

// ── Safari 复制修复 ──
function initFeatures() {
  try {
    features = loadFeatures({
      app,
      ipcMain,
      log: (m) => console.log('[feature]', m),
      settings: {
        // 取某个功能的命名空间
        namespace: (id) => (featureSettings[id] = featureSettings[id] || {}),
        // 写某个功能的某个键并落盘
        setNamespace: (id, key, value) => {
          featureSettings[id] = featureSettings[id] || {};
          featureSettings[id][key] = value;
          saveSettings();
        },
      },
    });
    console.log('[feature] 已初始化:', JSON.stringify(features.list()));
  } catch (error) {
    console.log('[feature] 初始化失败:', error);
  }
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  // macOS 惯例：关掉窗口 App 继续在后台运行。
  // 「Safari 复制修复」是**常驻能力**（要一直盯着浏览器、随时接管复制），
  // 如果关窗口就退出，等于用户随手一点就把功能关掉了 —— 实测会表现为
  // 「复制完全不修复」。Dock 图标还在，随时可以点回来开窗口。
  //
  // **Windows 线同口径**(2026-10-24 用户口径):关窗口只是把窗口**藏起来**,
  // 进程留着(托盘图标还在)。这里**不退出** —— 真退出有两个入口:
  // 右上角「关闭软件」按钮(`window:quit`)或托盘菜单的「退出程序」。
  // (正常情况下这里根本不会触发:窗口的 close 被拦着,只是被 hide 了。
  //  真的走到这里 = 窗口是真的全没了,那才允许退出。)
  if (process.platform !== 'darwin') {
    isQuitting = true;
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  try { globalShortcut.unregisterAll(); } catch (_) {}
  stopKeepalive();
  try { features?.disposeAll(); } catch (_) {}
});
