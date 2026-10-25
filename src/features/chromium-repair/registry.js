/**
 * Windows 的「浏览器复制修复」—— 把 Chromium 扩展注册进 Chrome / Edge。
 *
 * ## 为什么是注册表
 *
 * Chrome / Edge 在**启动时**读一份「外部扩展清单」。Windows 上这份清单可以来自
 * 注册表的 `HKCU\Software\Google\Chrome\Extensions\<id>`（Edge 是
 * `HKCU\Software\Microsoft\Edge\Extensions\<id>`），里面写两值：
 *
 * ```text
 * path     = 扩展目录的绝对路径
 * version  = 与 manifest 里一致的版本号
 * ```
 *
 * 写进去之后，扩展以「外部安装」的身份出现：
 *   - **不需要开发者模式**
 *   - 用户**不用**去 chrome://extensions 里「加载已解压的扩展程序」
 *   - 用户**不用**自己选文件夹
 *
 * 这就是「和 Mac 一样的工作方式」在 Windows 上能做到的最简形态：
 * mac 上是「Safari 复制修复」那个开关，Windows 上也是**一个开关**。
 *
 * ## 扩展 ID 为什么是固定的
 *
 * manifest 里带一个 `key` 字段（公钥 DER 的 base64）⇒ 扩展 ID 由**公钥**决定
 * （SHA-256 前 128 位 → 32 个 a..p 的字母），**与装在哪台机器、哪个目录无关**。
 * 于是注册表键名是常量，安装目录变了只要重写一次 `path` 就行。
 *
 * 与 Tauri 线（`tauri-app/src-tauri/src/chromium/repair.rs`）**同口径**：
 * 同一把公钥 ⇒ 同一个 ID ⇒ 同一个注册表键名。
 *
 * ## 边界
 *
 * - 写的是 **HKCU**（当前用户），不需要管理员权限。
 * - 浏览器**只在启动时**读这份清单 ⇒ 改完要**重启一次浏览器**才生效。
 *   这是浏览器的机制，界面必须把这句话说出来。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

/** Chrome / Edge 读外部扩展清单的位置（HKCU 下的相对路径）。 */
const CHROME_KEY_PATH = 'Software\\Google\\Chrome\\Extensions';
const EDGE_KEY_PATH = 'Software\\Microsoft\\Edge\\Extensions';

/** 支持的浏览器（写注册表时的目标）。 */
const BROWSERS = [
  ['chrome', 'Chrome'],
  ['edge', 'Edge'],
];

/** 扩展 ID：SHA-256(公钥 DER) 的前 128 位 → 32 个十六进制位 → 每位映射到 a..p。 */
function idFromPublicKey(der) {
  const hash = crypto.createHash('sha256').update(der).digest();
  let out = '';
  for (const byte of hash.subarray(0, 16)) {
    out += String.fromCharCode(97 + (byte >> 4));
    out += String.fromCharCode(97 + (byte & 0x0f));
  }
  return out;
}

/** 扩展目录的候选位置（打包后 / 开发时）。 */
function extensionDirCandidates() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'browser-extension'));
    candidates.push(path.join(process.resourcesPath, 'dist-core', 'chromium'));
  }
  // 开发时（未打包）：仓库里的构建产物
  candidates.push(path.join(__dirname, '..', '..', '..', 'dist-core', 'chromium'));
  return candidates;
}

/** 扩展目录（装在应用包里那份）；找不到返回 null。 */
function findExtensionDir() {
  return (
    extensionDirCandidates().find((dir) => fs.existsSync(path.join(dir, 'manifest.json'))) || null
  );
}

/** 读扩展的 manifest。 */
function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * 扩展 ID —— **从实际装着的那个扩展的 manifest 算**，
 * 所以它永远与浏览器将要加载的那份扩展一致。
 */
function extensionId(manifest) {
  const key = manifest && manifest.key;
  if (!key || typeof key !== 'string') return null;
  try {
    return idFromPublicKey(Buffer.from(key.trim(), 'base64'));
  } catch (_) {
    return null;
  }
}

function registryKey(browser, id) {
  const base = browser === 'edge' ? EDGE_KEY_PATH : CHROME_KEY_PATH;
  return `HKCU\\${base}\\${id}`;
}

/**
 * 跑一条 `reg.exe` 命令。
 *
 * 用 `reg.exe` 而不是 node-winreg 之类的原生模块：它每个 Windows 都有，
 * 不用给打包引入原生依赖；而且**退出码与界面语言无关**
 * （`reg query` 的输出是本地化的，不能靠解析文本）。
 */
function reg(args) {
  const result = spawnSync('reg.exe', args, { stdio: 'ignore', windowsHide: true });
  if (result.error) return { ok: false, error: result.error.message };
  return { ok: result.status === 0 };
}

/** 把扩展注册进指定浏览器。 */
function registerBrowser(browser, id, dir, version) {
  const key = registryKey(browser, id);
  const pathResult = reg([
    'add', key, '/v', 'path', '/t', 'REG_SZ', '/d', dir, '/f',
  ]);
  if (!pathResult.ok) {
    return { ok: false, error: pathResult.error || '写注册表 path 失败（reg.exe 返回失败）' };
  }
  const versionResult = reg([
    'add', key, '/v', 'version', '/t', 'REG_SZ', '/d', version, '/f',
  ]);
  if (!versionResult.ok) {
    return { ok: false, error: versionResult.error || '写注册表 version 失败（reg.exe 返回失败）' };
  }
  return { ok: true };
}

/** 从指定浏览器注销扩展。键本来就不在 ⇒ 也算成功（幂等）。 */
function unregisterBrowser(browser, id) {
  // 键不存在时 reg.exe 返回非 0 —— 那正是「已经注销了」，算成功。
  reg(['delete', registryKey(browser, id), '/f']);
  return { ok: true };
}

/** 指定浏览器里是不是已经注册了。 */
function isRegisteredBrowser(browser, id) {
  return reg(['query', registryKey(browser, id), '/v', 'path']).ok;
}

/** 已经注册了扩展的浏览器名。 */
function registeredBrowsers(id) {
  return BROWSERS.filter(([browser]) => isRegisteredBrowser(browser, id)).map(([, label]) => label);
}

/**
 * Chrome / Edge 现在是不是开着。
 *
 * 只看进程名（`chrome.exe` / `msedge.exe`）—— `tasklist` 的**表头是本地化的**，
 * 但镜像名不是，所以只按名字匹配是稳的。
 */
function browsersRunning() {
  const result = spawnSync('tasklist.exe', [], { encoding: 'utf8', windowsHide: true });
  if (result.error || !result.stdout) return [];
  const text = String(result.stdout).toLowerCase();
  const running = [];
  for (const [process, label] of [['chrome.exe', 'Chrome'], ['msedge.exe', 'Edge']]) {
    if (text.includes(process)) running.push(label);
  }
  return running;
}

module.exports = {
  BROWSERS,
  browsersRunning,
  extensionDirCandidates,
  extensionId,
  findExtensionDir,
  idFromPublicKey,
  isRegisteredBrowser,
  readManifest,
  registeredBrowsers,
  registerBrowser,
  registryKey,
  unregisterBrowser,
};
