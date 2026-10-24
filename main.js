const { app, BrowserWindow, globalShortcut, ipcMain, clipboard } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const nacl = require('tweetnacl');
// 快捷键的 latch 状态机(纯函数,能单独测 —— 见 tools/verify/verify-shortcut-latch.cjs)
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
    if (mainWindow) {
      mainWindow.isMinimized() ? mainWindow.restore() : mainWindow.show();
      mainWindow.focus();
    }
  });
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

// ── Playback safety ──
//
// 2026-10-23 T0 事故:回放时发出的**合成点击**如果落在 App **自己的窗口**上,
// 就会点到自己界面上的「默认执行」→ 又一次回放 → 合成点击又点自己 →
// **无限自激循环** → 疯狂敲键盘 → 整台机器卡死(用户被迫强制关机)。
//
// 两道闸(与 Tauri 版同口径,见 tauri 的 ADR-0021):
// ① **重入保护**:同一时刻最多一个回放,后来的直接拒绝;
// ② **落点在自己窗口上的点击不发出去**。
//
// ⚠️ 这两道闸不能去掉。少任何一道,一次误触就能把用户的机器搞死。
//
// 闸本身放在 `playback-guard.cjs`(纯函数,能直接跑 node --test)。
const { pointInRect, createPlaybackGuard } = require('./playback-guard.cjs');
const playbackGuard = createPlaybackGuard();

// 自己窗口在屏幕上的范围(逻辑点,左上角为原点)——与 mouseClick 的坐标同一套。
function ownWindowBounds() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    return mainWindow.getBounds();
  } catch (_) {
    return null;
  }
}

// 点 (x, y) 是否落在自己窗口里。
function pointInOwnWindow(x, y) {
  return pointInRect(ownWindowBounds(), x, y);
}

// 回放期间让窗口**穿透**(不接收鼠标事件),返回有没有成功。
//
// ## 为什么必须有它
//
// App 的窗口是 always-on-top 的小面板,**常常正好盖在目标网站的输入框上面**。
// 回放要点击的位置如果落在自己窗口上:
// - 不穿透 ⇒ 那个点击变成**点自己** ⇒ 点中自己的「默认执行」⇒ 又一次回放
//   ⇒ **无限自激循环**(2026-10-23 T0)⇒ 疯狂键入 ⇒ 机器卡死;
// - 而"跳过落在自己窗口上的点击"也不行 ⇒ 那些点击往往**正是要点的输入框**,
//   跳过了回放就点不进去(功能缺失)。
//
// 穿透成功 ⇒ 点击**正常落到下面的应用** ⇒ 既不自激,回放也完整。
// 穿透失败 ⇒ 退回"跳过落在自己窗口上的点击"(兜底)。
function setWindowPassthrough(ignore) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
    return true;
  } catch (_) {
    return false;
  }
}

// 闸 ① 的**入口检查**:起回放之前同步问一次。
// 只检查、不计数 —— 计数由 playClicks 内部那一次负责(免得记两次)。
function playbackBusy() {
  return playbackGuard.isBusy();
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
  const penetrated = setWindowPassthrough(true);
  let executed = 0;
  let skipped = 0;
  // 第一次失败的原因(与 Tauri 版同口径:记第一个错误,但**继续往下走**)。
  let error = '';
  try {
    for (let i = 0; i < clicks.length; i++) {
      const c = clicks[i];
      // 闸 ②:**只在穿透失败时才跳过**。
      // 穿透了的话点击会正常落到下面的应用上(那才是回放要点的目标),
      // 跳过反而会让回放少点几下 —— 而那些点击往往正是"点进输入框"的位置。
      if (!penetrated && pointInOwnWindow(c.x, c.y)) {
        skipped += 1;
      } else {
        // **发不出去就不算执行**(与 Tauri 版同口径)。
        //
        // 原生层没有「辅助功能」权限时会抛错 ⇒ 这里拿到 null ⇒
        // 系统把事件**静默丢弃**了,屏幕上什么都没发生 ——
        // 那种情况下把它计成"执行了"就是骗人(用户看到计数在涨,却什么都没发生)。
        const sent = nativeCall('mouseClick', c.x, c.y);
        if (sent === null) {
          if (!error) {
            error = '模拟点击发不出去(通常是系统没给「辅助功能」权限:'
              + '系统设置 → 隐私与安全性 → 辅助功能 → 勾选本应用)';
          }
        } else {
          executed += 1;
        }
      }
      await sleepMs(100);

      if (perClickInputs && perClickInputs[i]) {
        await sleepMs(100);
        if (nativeCall('sendText', perClickInputs[i]) === null && !error) {
          error = '键入文本发不出去(通常是系统没给「辅助功能」权限)';
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
  return { executed, skipped, rejected: false, error };
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

// 发合成事件之前的**权限前置检查**(macOS)。
//
// ## 为什么必须有
//
// 没有「辅助功能」权限时,`CGEventPost` 会被系统**静默丢弃**:
// 命令返回成功、界面显示「开始执行」,但屏幕上什么都没发生 ——
// 用户只会觉得"这个软件是坏的"(2026-10-24 用户原话:「默认执行是没有功能的」)。
//
// 所以这里提前拦下来,把原因**直接**告诉界面 ——
// 界面本来就会显示 `result.message`,不用为它另开一条通路。
//
// 与 Tauri 版同口径(那边是原生层的 `require_accessibility` 闸门;
// 这里是**入口处**再拦一道,让用户立刻看到原因,而不是等回放跑完)。
const ACCESSIBILITY_HINT =
  '没有「辅助功能」权限,模拟点击/键入发不出去:'
  + '系统设置 → 隐私与安全性 → 辅助功能 → 勾选本应用(改完要重开软件)';

function accessibilityBlocked() {
  if (process.platform !== 'darwin') return false;   // Windows 的 SendInput 不需要授权
  if (!native) return false;                         // 模块没加载是另一个错(界面已有横幅)
  return nativeCall('accessibilityTrusted') !== true;
}

// Window controls (unchanged)
ipcMain.handle('window:quit', () => app.quit());
ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});

// 打开「系统设置 → 隐私与安全性 → 辅助功能」。
//
// 界面上的小问号点一下就该把人送到能改的地方,而不是让人自己找路径
// (与 Tauri 版 `open_accessibility_settings` 同口径)。
ipcMain.handle('window:openAccessibilitySettings', async () => {
  if (process.platform !== 'darwin') {
    return { ok: false, error: '只有 macOS 有「辅助功能」设置页' };
  }
  try {
    execFileSync('open', [
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    ], { stdio: 'ignore' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

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
  // 发合成点击/按键需要 macOS 的「辅助功能」权限;
  // 没有的话事件会被系统**静默丢弃**(命令返回成功,但什么都没发生)。
  // 所以这个状态必须报给界面(与 Tauri 版同口径)。
  accessibilityTrusted: nativeCall('accessibilityTrusted') === true,
  // 快捷键与 latch 的诊断字段(**与 win 分支同名字同含义**)。
  //
  // 排查「按了快捷键没反应」时按这个顺序看:
  // ① ctrlS / ctrlD —— 热键**注册**成功没有(被别的 App 抢走就是 false);
  // ② latchAvailable / controlWatcherRunning —— Control 只读观察器在不在跑
  //    (不在跑 ⇒ latch 根本解不开,按住 Ctrl 连按会连着触发);
  // ③ latchArmed —— 当前是不是武装的(锁着就触发不了)。
  shortcutCtrlS: shortcutStatus.ctrlS,
  shortcutCtrlD: shortcutStatus.ctrlD,
  latchAvailable: shortcutStatus.latchAvailable,
  latchArmed: shortcutStatus.latchArmed,
  controlWatcherRunning: shortcutStatus.controlWatcherRunning,
}));

// 让系统弹出「辅助功能」授权框(用户在弹窗里点「允许」)。
ipcMain.handle('native:requestAccessibility', async () => {
  return nativeCall('requestAccessibility') === true;
});

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
ipcMain.handle('native:startRecording', async () => {
  try {
    // 排除矩形用**主进程**的窗口位置算(权威值),不采信渲染进程传过来的那份:
    // 渲染进程那份是「开始录制那一刻」的快照,窗口一动就过期了。
    let rect = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      const b = mainWindow.getBounds();
      rect = [b.x, b.y, b.x + b.width, b.y + b.height];
    }
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
    if (accessibilityBlocked()) {
      return { status: 'error', message: ACCESSIBILITY_HINT };
    }
    // 闸 ① 的**入口检查**:起回放之前同步问一次 ——
    // 这样界面能**立刻**知道"被拒绝了",而不是等整个回放跑完才发现。
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
    if (accessibilityBlocked()) {
      return { status: 'error', message: ACCESSIBILITY_HINT };
    }
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
  if (accessibilityBlocked()) {
    return { status: 'error', message: ACCESSIBILITY_HINT };
  }
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
  // 会被当成一次外部点击。所以窗口**每次移动/变高**都刷新一次。
  //
  // (Tauri 版同口径:窗口事件里刷新,见 tauri-app/src-tauri/src/lib.rs。)
  const refreshExcludeRect = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const b = mainWindow.getBounds();
    nativeCall('setExcludeRect', [b.x, b.y, b.x + b.width, b.y + b.height]);
  };
  mainWindow.on('move', refreshExcludeRect);
  mainWindow.on('resize', refreshExcludeRect);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  const indexPath = path.join(__dirname, 'dist', 'index.html');
  console.log(`[main] loading ${indexPath}`);
  mainWindow.loadFile(indexPath);

  return mainWindow;
}

// ── Shortcuts ──

async function triggerDefaultExecute() {
  // **权限前置检查**:没有「辅助功能」权限时,合成点击会被系统静默丢弃 ——
  // 回放"跑完了"但屏幕上什么都没发生,用户只会觉得"默认执行没有功能"。
  if (accessibilityBlocked()) {
    console.error('[trigger] ' + ACCESSIBILITY_HINT);
    return;
  }
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
  if (accessibilityBlocked()) {
    console.error('[trigger] ' + ACCESSIBILITY_HINT);
    return;
  }
  const source = pinyinSourcesSetting?.shortcut === 'textbox' ? 'textbox' : 'clipboard';
  const t = (source === 'textbox' ? pinyinTextSetting : clipboard.readText() || '').trim();
  if (!t) return;

  await pinyinType(t, 0, !!autoSwitchImeSetting);
}

// 启动时主动**索要**「辅助功能」权限。
//
// ## 为什么要有
//
// 没有这个权限,合成点击/按键会被系统**静默丢弃** ⇒
// 「默认执行」(回放)、键入文本、录制**全都没功能**,而界面还不报错
// (2026-10-24 用户原话:「默认执行是没有功能的」)。
//
// 让系统弹一次授权框,用户在弹窗里点「允许」就完事 ——
// 比"自己去系统设置里把这个 App 拖进列表"省事得多。
//
// 已经有权限时**什么都不做**(系统也不会重复弹)。
function requestAccessibilityIfNeeded() {
  if (process.platform !== 'darwin') return;
  if (!native) return;
  if (nativeCall('accessibilityTrusted') === true) return;
  try {
    nativeCall('requestAccessibility');
    console.log('[accessibility] 没有「辅助功能」权限,已向系统申请(授权后模拟点击/键入才能发出去)');
  } catch (_) {
    // 请求本身失败不影响 App 启动 —— 界面上还有小问号可以点。
  }
}

/**
 * 快捷键与 latch 的运行状态(诊断用)。
 *
 * **与 win 分支同名字、同含义** —— 两个平台的排查顺序一致:
 * ctrlS/ctrlD 看热键**注册**成没成,latchAvailable/controlWatcherRunning
 * 看 Control 只读观察器在不在跑,latchArmed 看当前能不能触发。
 */
const shortcutStatus = {
  /** ⌃S(默认执行 = 回放)注册成功没有 */
  ctrlS: false,
  /** ⌃D(剪贴板直输)注册成功没有 */
  ctrlD: false,
  /** latch 可用吗(= Control 只读观察器起来了没有) */
  latchAvailable: false,
  /** 当前是不是武装的(诊断用) */
  latchArmed: true,
  /** Control 观察器在不在跑 */
  controlWatcherRunning: false,
};

function registerShortcuts() {
  // 快捷键:**⌃S** = 默认执行(回放)、**⌃D** = 读剪贴板并键入。
  //
  // ## latch(2026-10-23 用户要求)
  //
  // > 「触发之后 Ctrl+D 整个按键就不再会继续影响它了,
  // > 除非下一次重新按住 Ctrl,再点击相应的字母」
  //
  // `globalShortcut` **只在按下时回调**,不告诉你 Control 什么时候松开 ⇒
  // 靠它自己解不开 latch(按住 Ctrl 连按会连着触发;而「默认执行」是回放,
  // 连着触发就是往屏幕上乱点)。
  // 所以另开一个**只读**观察(CGEventTap ListenOnly,**不需要辅助功能权限**)
  // 看 Control 的按下/松开边沿:Control 一松开就重新武装。
  //
  // ## 规则(**Tauri 版 / win 分支同口径**;见本仓库 ADR-0013 / Tauri 仓库 ADR-0024)
  //
  // - 触发 ⇒ `armed = false` 且 `blocked = true`;
  // - **Control 松开** ⇒ `blocked = false`、`armed = true`(彻底解锁);
  // - Control 按下 ⇒ **只有 `blocked == false` 时**才武装。
  //
  // 最后一条是关键:系统热键的回调和只读观察的回调**谁先到不确定**。
  // 如果「Control 按下」那一下能把 latch 解开,用户按住 Ctrl 连按会连着
  // 触发 —— 而「默认执行」是回放,触发多次就是往屏幕上乱点。
  //
  // ## 两个平台怎么观察 Control(机制不同,对外形态一致)
  //
  // - macOS:`CGEventTap` ListenOnly(不需要辅助功能权限);
  // - Windows:`win-input` 的 `GetAsyncKeyState(VK_CONTROL)` 轮询 + 边沿检测
  //   (读物理状态,不受 `RegisterHotKey` 影响,也没有低级钩子的超时风险)。
  //
  // ⇒ 对外都是 `nativeCall('watchControlKey', cb)`,**调用形态逐字相同**;
  // 拿不到观察源时**如实降级**(`latch=false` + 打 warn),**不假装 latch 生效了**。
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

  const ok1 = globalShortcut.register('Ctrl+S', fire(triggerDefaultExecute, 'default execute'));
  // 剪贴板直输:macOS 这边多一步「切到 ASCII 输入源」(拼音键入需要),
  // Windows 没有「输入源」这个概念 ⇒ 那边靠 WM_CHAR 直接送字符。
  // ⇒ **两个平台都注册 ⌃D**,「切输入源」那一步是 macOS 专有(ADR-0012 平台必需差异)。
  const ok2 = process.platform === 'darwin'
    ? globalShortcut.register('Ctrl+D', fire(triggerPinyinFromClipboard, 'pinyin'))
    : null;

  shortcutStatus.ctrlS = ok1 === true;
  shortcutStatus.ctrlD = ok2 === true;
  shortcutStatus.latchAvailable = canLatch;
  shortcutStatus.latchArmed = latch.isArmed();
  shortcutStatus.controlWatcherRunning = canLatch;

  console.log(`[shortcut] Ctrl+S=${ok1} Ctrl+D=${ok2} latch=${canLatch}`);
}

// ── App Lifecycle ──

app.on('ready', () => {
  migrateLegacyDataFiles();
  loadSettings();
  createWindow();
  registerShortcuts();
  startKeepalive();
  initFeatures();
  runRecordingExclusionDiag();
  requestAccessibilityIfNeeded();
});

// 启动参数带 `--diag-recording-exclusion` 时,跑一次
// 「点自己界面上的按钮会不会被记成一次点击」的自检,
// 结果写进 <userData>/diag-recording.json。
//
// 平时**不跑** —— 它会往自己窗口里发合成点击,
// 不该在用户正常用的时候发生。要查这件事时再手动带这个参数启动。
function runRecordingExclusionDiag() {
  if (!process.argv.includes('--diag-recording-exclusion')) return;
  setTimeout(() => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const b = mainWindow.getBounds();
      const rect = [b.x, b.y, b.x + b.width, b.y + b.height];
      // 窗口左侧那条透明边距 —— 点这里没有任何副作用,又确实在窗口范围内
      const point = [b.x + 4, b.y + 60];
      const result = nativeCall('diagnoseExclusion', rect, point) ||
        { error: '原生模块没有 diagnoseExclusion(平台不支持?)' };
      const out = { ...result, rect, point, at: new Date().toISOString() };
      const file = path.join(app.getPath('userData'), 'diag-recording.json');
      fs.writeFileSync(file, JSON.stringify(out, null, 2));
      console.log('[diag] 录制排除自检:', JSON.stringify(out));
    } catch (e) {
      console.error('[diag] 录制排除自检失败:', e && e.message);
    }
  }, 2500);
}

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
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (_) {}
  stopKeepalive();
  try { features?.disposeAll(); } catch (_) {}
});
