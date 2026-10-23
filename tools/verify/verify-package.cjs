/**
 * 打包产物自检 —— 防止再打出"装上但功能是坏的"的包。
 *
 * 检查项:
 *   1. app.asar.unpacked 里有原生模块(.node)  ← 这里出过事:被塞进 asar 就 dlopen 不了
 *   2. 原生模块能真正被加载并导出预期方法
 *   3. Safari 复制修复的运行时文件都在 asar 里
 *   4. vendor 里的参考库/字体解析器都在
 *
 *   node tools/verify/verify-package.cjs [appPath]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// 必须解析成**绝对路径**：下面的 require(nodePath) 遇到相对路径会直接报
// "Cannot find module"（上一轮就因为传了相对路径误报成"原生模块坏了"）。
//
// 查找顺序：命令行参数 → 本地构建产物 → 已安装的 App。
// （release/ 是构建产物、随时可重建，清理后不该让自检脚本直接报"找不到"。）
const APP_CANDIDATES = [
  process.argv[2],
  path.join(__dirname, '..', '..', 'release', 'mac-arm64', '模拟输入.app'),
  '/Applications/模拟输入.app',
].filter(Boolean);
const APP = APP_CANDIDATES.find((p) => fs.existsSync(path.join(p, 'Contents', 'Resources', 'app.asar'))) || path.resolve(APP_CANDIDATES[0]);
const RESOURCES = path.join(APP, 'Contents', 'Resources');
const ASAR = path.join(RESOURCES, 'app.asar');
const UNPACKED = path.join(RESOURCES, 'app.asar.unpacked');

let failed = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
}

console.log(`检查安装包: ${APP}\n`);

if (!fs.existsSync(ASAR)) {
  console.error('✖ 找不到 app.asar,先构建:');
  console.error('  npm run build && npm run build:native && npx electron-builder --mac dmg --arm64');
  process.exit(1);
}

// ① 原生模块必须解包
const nodePath = path.join(UNPACKED, 'mac-coregraphics', 'build', 'Release', 'mac-coregraphics.node');
check('原生模块已解包到 app.asar.unpacked', fs.existsSync(nodePath),
  fs.existsSync(nodePath) ? '' : '(在 asar 里的话 Electron 无法 dlopen → 模拟输入等全部静默失效)');

// ② 原生模块能真正加载
if (fs.existsSync(nodePath)) {
  try {
    const binding = require(nodePath);
    const need = ['mouseClick', 'sendText', 'sendKey', 'getCurrentInputSource', 'startRecording'];
    const missing = need.filter((k) => typeof binding[k] !== 'function');
    check('原生模块可加载且导出预期方法', missing.length === 0,
      missing.length ? '缺少: ' + missing.join(',') : `(${Object.keys(binding).length} 个方法)`);
  } catch (e) {
    check('原生模块可加载', false, e.message);
  }
}

/** 把 asar 解到指定目录:优先用 @electron/asar 的 API,兜底走命令行。 */
function extractAsar(asarPath, outDir) {
  try {
    const asar = require('@electron/asar');
    if (typeof asar.extractAll === 'function') {
      asar.extractAll(asarPath, outDir);
      return;
    }
  } catch (_) { /* 走命令行兜底 */ }
  const cli = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  execFileSync(cli, ['asar', 'extract', asarPath, outDir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * 相对 require 能不能在包里解析到。
 *
 * 依次试:原样 → 补 `.js` / `.cjs` / `.json` → 当目录找 `index.*`。
 * 另外:解包到 `app.asar.unpacked` 的文件(原生模块)也算存在 ——
 * asar 里只存占位,真文件在 unpacked 目录。
 */
function resolvesInside(fromFile, spec, root) {
  const target = path.resolve(path.dirname(fromFile), spec);
  const rel = path.relative(root, target);
  const candidates = [
    target,
    target + '.js',
    target + '.cjs',
    target + '.json',
    path.join(target, 'index.js'),
    path.join(target, 'index.cjs'),
    path.join(target, 'index.json'),
  ];
  if (rel && !rel.startsWith('..')) {
    const unpacked = path.join(UNPACKED, rel);
    candidates.push(unpacked, unpacked + '.js', path.join(unpacked, 'index.js'));
  }
  return candidates.some(c => {
    try {
      return fs.existsSync(c) && fs.statSync(c).isFile();
    } catch (_) {
      return false;
    }
  });
}

// ③ Safari 修复运行时文件在 asar 里
/**
 * 读 asar 里的文件清单。
 * 优先用 @electron/asar 的 API(纯 JS、跨平台);
 * 兜底走命令行时**必须按平台选 npx / npx.cmd** —— Windows 上 npx 是 npx.cmd,
 * 直接 spawn 'npx' 会 ENOENT(踩过:清单读不到 → 一堆检查假失败)。
 */
function listAsar(asarPath) {
  try {
    const asar = require('@electron/asar');
    if (typeof asar.listPackage === 'function') {
      return asar.listPackage(asarPath).map((p) => String(p).replace(/\\/g, '/'));
    }
  } catch (_) { /* 走命令行兜底 */ }
  const cli = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  try {
    return execFileSync(cli, ['asar', 'list', asarPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    console.log('  (无法读取 asar 列表:', e.message + ')');
    return null;
  }
}

const asarList = listAsar(ASAR);
if (asarList === null) {
  // 读不到清单 → 下面的"含/不含"判断全都失去意义,必须当作失败
  check('能读取 asar 清单', false, '清单读不到 → 内容检查无法进行');
} else {
const needFiles = [
  '/src/features/safari-repair/engine.js',
  '/src/features/safari-repair/coordinator.js',
  '/src/features/safari-repair/bridge.js',
  '/src/features/safari-repair/fast-matcher.js',
  '/src/features/safari-repair/paths.js',
  '/src/features/index.js',
  '/vendor/page-guard.js',
  '/vendor/frame-bridge.js',
  '/vendor/copy-repair-core.cjs',
  '/vendor/opentype.js',
  '/vendor/common-charset.js',
  '/vendor/glyph-db-48.crdb.gz',
];
for (const f of needFiles) {
  check(`asar 内含 ${f}`, asarList.includes(f));
}
check('asar 内不含功能自测目录', !asarList.some((f) => f.startsWith('/src/features/') && f.includes('/test/')));
check('asar 内不含文档系统', !asarList.some((f) => f.startsWith('/docs/')));
check('asar 内不含开发脚本', !asarList.some((f) => f.startsWith('/tools/')));
// 算法侧源码(2026-10-21 由独立算法仓并入):只有 vendor/ 里的**构建产物**该进包,
// 源码、扩展、测试都不该进包(否则安装包凭空大几十 MB)。
check('asar 内不含算法源码 packages/', !asarList.some((f) => f.startsWith('/packages/')));
check('asar 内不含浏览器扩展 apps/', !asarList.some((f) => f.startsWith('/apps/')));
check('asar 内不含跨浏览器测试 tests/', !asarList.some((f) => f.startsWith('/tests/')));
check('asar 内不含零散 markdown', !asarList.some((f) => f.endsWith('.md') && !f.startsWith('/node_modules/')));
} // ← asar 清单可读

// ⑤ 把 asar 解出来真跑一遍引擎：路径写错、vendor 缺失都会在这里当场暴露
// ⑥ 包内**所有相对 require 都必须能解析** —— 这是"装上就崩"的根因(见下)
{
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cr-verify-'));
  try {
    extractAsar(ASAR, tmp);
    const enginePath = path.join(tmp, 'src/features/safari-repair/engine.js');
    const mod = require(enginePath);
    const engine = new mod.GlyphEngine({ log: () => {} });
    // 真正走一遍 vendor 路径解析：模块层级写错、参考库缺失都会在这里暴露
    const db = engine.load();
    check('解包后引擎可加载且参考库可解析', true,
      `${db.header.count} 字 / 栅格 ${db.header.gridSize}`);
    check('解包后功能注册表可加载', typeof require(path.join(tmp, 'src/features/index.js')).loadFeatures === 'function');

    // ⑥ 相对 require 的完整性
    //
    // ## 为什么必须有这一条
    //
    // 2026-10-23 出过一次事故:electron-builder 的 `files` 是**白名单**,
    // 新加在仓库根目录的 `playback-guard.cjs` / `shortcut-latch.cjs`
    // 没被写进白名单 ⇒ **没进包** ⇒ `main.js` 顶层 `require(...)` 直接抛
    // ⇒ App **启动即崩**(弹「A JavaScript error occurred in the main process」)。
    //
    // 而当时的打包自检只看 Safari 引擎和 vendor 文件 ⇒ **CI 全绿、装上就是坏的**。
    //
    // ⇒ 这一条把"漏打包"这类问题**在打包那一刻**就拦下来。
    const missing = [];
    let scanned = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(tmp, full);
        // 第三方依赖自己会解析(可选依赖常常没被打进去),不扫
        if (rel.split(path.sep)[0] === 'node_modules') continue;
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(js|cjs|mjs)$/.test(entry.name)) continue;
        scanned += 1;
        const src = fs.readFileSync(full, 'utf-8');
        // 只认**字面量**的相对 require;计算路径(require(变量))静态查不了,跳过
        const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
        let m;
        while ((m = re.exec(src)) !== null) {
          if (!resolvesInside(full, m[1], tmp)) {
            missing.push(`${rel.split(path.sep).join('/')} → ${m[1]}`);
          }
        }
      }
    };
    walk(tmp);
    check('包内所有相对 require 都能解析(装上不崩)', missing.length === 0,
      missing.length
        ? `缺 ${missing.length} 个: ${missing.slice(0, 6).join(' ; ')}`
        : `(扫了 ${scanned} 个文件)`);
  } catch (e) {
    check('解包后引擎可加载', false, e.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(failed === 0 ? '\n✔ 打包产物自检全部通过' : `\n✖ ${failed} 项不通过`);
process.exit(failed === 0 ? 0 : 1);
