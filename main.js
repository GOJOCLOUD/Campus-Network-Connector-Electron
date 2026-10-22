const { app, BrowserWindow, globalShortcut, ipcMain, clipboard } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const nacl = require('tweetnacl');

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

async function playClicks(clicks, interval, inputs) {
  const perClickInputs = Array.isArray(inputs)
    ? inputs.map(i => (i && String(i).trim()) ? String(i).trim() : null)
    : null;

  for (let i = 0; i < clicks.length; i++) {
    const c = clicks[i];
    nativeCall('mouseClick', c.x, c.y);
    await sleepMs(100);

    if (perClickInputs && perClickInputs[i]) {
      await sleepMs(100);
      nativeCall('sendText', perClickInputs[i]);
    }

    if (i < clicks.length - 1) {
      await sleepMs(Math.max(50, interval * 1000));
    }
  }
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
ipcMain.handle('native:startRecording', async (_e, excludeRect) => {
  try {
    nativeCall('startRecording', excludeRect || [0, 0, 0, 0]);
    return true;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('native:stopRecording', async () => {
  nativeCall('stopRecording', );
  const clicks = nativeCall('getRecordingClicks', );
  nativeCall('clearRecordingClicks', );
  return Array.isArray(clicks) ? clicks : [];
});

ipcMain.handle('native:getRecordingClicks', async () => {
  return nativeCall('getRecordingClicks', );
});

ipcMain.handle('native:clearRecordingClicks', async () => {
  nativeCall('clearRecordingClicks', );
  return true;
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

  await pinyinType(t, 0, !!autoSwitchImeSetting);
}

function registerShortcuts() {
  const ok1 = globalShortcut.register('Ctrl+Shift+A', () => {
    triggerDefaultExecute().catch(e => console.error('[shortcut] default execute failed', e));
  });
  // 剪贴板直输走的是「输入源切换 + 拼音键入」这套 macOS 打法，
  // Windows 上没有等价物（那边靠 WM_CHAR 直接送字符），所以不注册这个快捷键。
  const ok2 = process.platform === 'darwin'
    ? globalShortcut.register('Ctrl+Shift+D', () => {
      triggerPinyinFromClipboard().catch(e => console.error('[shortcut] pinyin failed', e));
    })
    : null;
  console.log(`[shortcut] Ctrl+Shift+A=${ok1} Ctrl+Shift+D=${ok2}`);
}

// ── App Lifecycle ──

app.on('ready', () => {
  migrateLegacyDataFiles();
  loadSettings();
  createWindow();
  registerShortcuts();
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
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (_) {}
  stopKeepalive();
  try { features?.disposeAll(); } catch (_) {}
});
