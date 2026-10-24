/**
 * Windows 打包产物自检 —— 防止再打出"装上但功能是坏的"的包。
 *
 * Windows 侧最要命的一个坑(见 ADR-0003,macOS 上先踩过一遍):
 *   原生模块(.node)被塞进 app.asar → Electron 无法 dlopen → require 直接抛错。
 * 而旧版 Windows 分支的 main.js 是**顶层无条件 require** 原生模块,
 * 于是这个错误直接把主进程带崩 —— App 根本起不来,用户看到的就是"用不了"。
 *
 * 检查项:
 *   1. win-input.node 在 app.asar.unpacked 里(不在 asar 里)
 *   2. 它能真正被加载并导出预期方法
 *   3. asar 内含运行必需文件(main.js / preload.js / dist / win-input/index.js)
 *   4. asar 内**不含** macOS 专属的东西(原生模块、参考库、算法源码、Tauri)
 *   5. 把 asar 解出来真跑一遍(相对路径层级写错、文件漏打包当场暴露)
 *   6. 包内**所有相对 require 都能解析** —— 这是"装上就崩"的根因(见下)
 *
 *   node tools/verify/verify-package-win.cjs [appDir]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// 查找顺序:命令行参数 → 本地构建产物(win-unpacked / win-x64-unpacked / win-arm64-unpacked ...)。
const APP_CANDIDATES = [
  process.argv[2],
  ...(() => {
    const releaseDir = path.join(__dirname, '..', '..', 'release');
    if (!fs.existsSync(releaseDir)) return [];
    return fs.readdirSync(releaseDir)
      .filter((d) => /^win.*-unpacked$/.test(d))
      .map((d) => path.join(releaseDir, d));
  })(),
].filter(Boolean);
// 一个候选都没有时(本机没构建过 Windows 包)也要**友好报错**,
// 而不是崩在 `path.resolve(undefined)` 那种看不出所以然的栈里。
const APP = APP_CANDIDATES.find((p) => fs.existsSync(p))
  || (APP_CANDIDATES[0] ? path.resolve(APP_CANDIDATES[0]) : path.resolve('release', 'win-unpacked'));
const ASAR = path.join(APP, 'resources', 'app.asar');
const UNPACKED = path.join(APP, 'resources', 'app.asar.unpacked');

let failed = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
}

console.log(`检查安装包: ${APP}\n`);

if (!fs.existsSync(ASAR)) {
  console.error('✖ 找不到 app.asar,先构建:');
  console.error('  npm run build && npm run build:win-native && npx electron-builder --win --x64');
  process.exit(1);
}

// ① 原生模块必须解包(在 asar 里 = 装上必然起不来)
const nodePath = path.join(UNPACKED, 'win-input', 'build', 'Release', 'win-input.node');
check('原生模块已解包到 app.asar.unpacked', fs.existsSync(nodePath),
  fs.existsSync(nodePath) ? '' : '(在 asar 里的话 Electron 无法 dlopen → 整个 App 起不来)');

// ② 原生模块能真正加载,并导出预期方法
if (fs.existsSync(nodePath)) {
  try {
    const binding = require(nodePath);
    const need = [
      'mouseClick', 'sendText', 'sendKey', 'getCurrentInputSource',
      // 录制这一套:开始/停止/取/清/单条删除/刷新排除矩形
      'startRecording', 'stopRecording', 'getRecordingClicks',
      'clearRecordingClicks', 'removeRecordingClick', 'setExcludeRect',
      // 快捷键 latch 的只读观察器(Control 按下/松开)
      'watchControlKey',
    ];
    const missing = need.filter((k) => typeof binding[k] !== 'function');
    check('原生模块可加载且导出预期方法', missing.length === 0,
      missing.length ? '缺少: ' + missing.join(',') : `(${Object.keys(binding).length} 个方法)`);
  } catch (e) {
    check('原生模块可加载', false, e.message);
  }
}

// ③ asar 内容
/**
 * 读 asar 里的文件清单。
 * 优先用 @electron/asar 的 API(跨平台、纯 JS);
 * 兜底走命令行时**必须用 npx.cmd** —— Windows 上 npx 是 npx.cmd,
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
    '/main.js',
    '/preload.js',
    '/win-input/index.js',
    '/src/features/index.js',
  ];
  for (const f of needFiles) {
    check(`asar 内含 ${f}`, asarList.includes(f));
  }
  check('asar 内含前端产物', asarList.some((f) => f.startsWith('/dist/') && f.endsWith('index.html')));

  // ④ Windows 包里**不该有** macOS 的东西
  check('asar 内不含 macOS 原生模块', !asarList.some((f) => f.startsWith('/mac-coregraphics/')));
  check('asar 内不含参考库 vendor/', !asarList.some((f) => f.startsWith('/vendor/')));
  check('asar 内不含 Safari 修复模块', !asarList.some((f) => f.startsWith('/src/features/safari-repair/')));
  check('asar 内不含算法源码 packages/', !asarList.some((f) => f.startsWith('/packages/')));
  check('asar 内不含浏览器扩展 apps/', !asarList.some((f) => f.startsWith('/apps/')));
  check('asar 内不含 Tauri 源码', !asarList.some((f) => f.startsWith('/tauri-app/')));
  check('asar 内不含文档系统', !asarList.some((f) => f.startsWith('/docs/')));
  check('asar 内不含开发脚本', !asarList.some((f) => f.startsWith('/tools/')));
  check('asar 内不含功能自测目录', !asarList.some((f) => f.startsWith('/src/features/') && f.includes('/test/')));
}

// ⑦ 托盘图标必须在 **asar 外面**。
//
// Windows 的托盘是**系统**画的(`Shell_NotifyIcon`),系统读不了 asar 里的文件
// ⇒ 托盘图标必须用 `extraResources` 放到 `resources/` 下。
// 少了它 ⇒ 装完之后托盘建不起来 ⇒ 用户点叉把窗口收起来之后
// **就再也找不回窗口**(任务栏没有图标,也没有托盘)。
{
  const trayIcon = path.join(APP, 'resources', 'win-icon.ico');
  check('托盘图标在包内(asar 外面:resources/win-icon.ico)', fs.existsSync(trayIcon),
    fs.existsSync(trayIcon) ? '' : '少了它 ⇒ 装上后没有托盘图标');
}

/**
 * 把 asar 解到指定目录:优先用 @electron/asar 的 API,兜底走命令行。
 *
 * 兜底走命令行时**必须用 npx.cmd** —— Windows 上 npx 是 npx.cmd,
 * 直接 spawn 'npx' 会 ENOENT(踩过:清单读不到 → 一堆检查假失败)。
 */
function extractAsar(asarPath, outDir) {
  try {
    const asar = require('@electron/asar');
    if (typeof asar.extractAll === 'function') {
      asar.extractAll(asarPath, outDir);
      return;
    }
  } catch (_) { /* 走命令行兜底 */ }
  const cli = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  execFileSync(cli, ['asar', 'extract', asarPath, outDir], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
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

// ⑤ 把 asar 解出来真跑一遍 + ⑥ 相对 require 的完整性
//
// ## 为什么必须有 ⑥
//
// electron-builder 的 `build.files` 是**白名单**:新加在仓库根目录的
// `playback-guard.cjs` / `shortcut-latch.cjs` 没被写进白名单 ⇒ **没进包**
// ⇒ `main.js` 顶层 `require(...)` 直接抛 ⇒ App **启动即崩**
// (弹「A JavaScript error occurred in the main process」)。
//
// 而只看"asar 里有没有那几个文件"的检查**抓不到这一类** ——
// 这就是 macOS 侧 ADR-0014 的第一层门禁:把整个包解开,
// 把**每一个**相对 require 都解析一遍,解析不到就地报出来。
{
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cnc-win-verify-'));
  try {
    extractAsar(ASAR, tmp);
    // 功能注册表是纯 JS —— 解包后能 require 就说明目录层级没写错。
    try {
      const reg = require(path.join(tmp, 'src/features/index.js'));
      check('解包后功能注册表可加载', typeof reg.loadFeatures === 'function');
    } catch (e) {
      check('解包后功能注册表可加载', false, e.message);
    }

    // ⑥ 相对 require 的完整性
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
    check('解包后能跑一遍相对 require 检查', false, e.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(failed === 0 ? '\n✔ 打包产物自检全部通过' : `\n✖ ${failed} 项不通过`);
process.exit(failed === 0 ? 0 : 1);
