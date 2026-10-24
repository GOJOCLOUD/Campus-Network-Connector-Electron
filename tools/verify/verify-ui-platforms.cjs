/**
 * 界面裁剪自检 —— 验证「Windows 版不做录制、不做回放,但保留拼音输入」这件事
 * **真的发生在界面上**。
 *
 * 只看代码不够:平台判断写错了(或者判断的是构建期常量而不是运行时平台),
 * 界面照样会把不该出现的步骤渲染出来。所以这里用真实浏览器跑一遍:
 *
 *   - 模拟 darwin → 4 个步骤(激活 / 默认执行 / 模拟点击 / 键盘输入)
 *   - 模拟 win32  → 2 个步骤(激活 / 键盘输入),界面上既没有「模拟点击」,
 *                   也没有「默认执行(回放)」这一屏
 *
 *   node tools/verify/verify-ui-platforms.cjs
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const DIST = path.join(__dirname, '..', '..', 'dist');
const PORT = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/** 起一个静态服务器,把 dist/ 挂上去 */
function serveDist() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = path.join(DIST, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(DIST)) {
        res.writeHead(403).end();
        return;
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, 'index.html');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

/** 造一个够用的 window.cnc 桩 */
function stub(platform, nativeStatus = null) {
  const status = nativeStatus || { ok: true, platform };
  return `(function () {
    window.cnc = {
      platform: ${JSON.stringify(platform)},
      quit() {}, minimize() {}, maximize() {},
      getFeatures: async () => [],
      getFeatureStatus: async () => null,
      setFeatureEnabled() {}, setFeatureEnabledSetting() {},
      getNativeStatus: async () => (${JSON.stringify(status)}),
      getActivationSnapshot: async () => ({
        deviceUuid: 'test-uuid', trialUsed: true,
        trialExpiresAt: Date.now() + 86400000, licenseValid: true, license: ''
      }),
      startTrial: async () => ({}), saveLicense: async () => ({ ok: true }),
      clearLicense: async () => ({}), migrateLegacyActivation: async () => ({}),
      listFiles: async () => [{ name: 'demo.json' }],
      saveFile: async () => ({ status: 'success' }),
      renameFile: async () => ({ status: 'success' }),
      deleteFile: async () => ({ status: 'success' }),
      playFile: async () => ({ status: 'success' }),
      pinyinInput: async () => ({ status: 'success' }),
      startRecording: async () => true, stopRecording: async () => [],
      getRecordingClicks: async () => [], clearRecordingClicks: async () => true,
      settings: { setSelectedJson() {} },
    };
  })();`;
}

let failed = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
}

/**
 * 找可用的 Chrome。
 * puppeteer 会去找**精确版本号**的构建,本机缓存里常常是差几个补丁号的那个
 * (例:缓存 155.0.8059.79,puppeteer 要 155.0.8059.84)→ 直接启动失败。
 * 所以这里兜底:在 puppeteer 缓存目录里扫一个真实存在的可执行文件。
 */
const { resolveExecutablePath } = require('../chrome-path.cjs');
/** 读当前页面的步骤数与可见文案 */
async function probe(page) {
  return page.evaluate(() => {
    const stepCircles = [...document.querySelectorAll('div')]
      .filter((d) => typeof d.className === 'string'
        && d.className.includes('h-8') && d.className.includes('w-8')
        && d.className.includes('rounded-full'));
    const text = document.body.innerText || '';
    return { steps: stepCircles.length, text };
  });
}

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('✖ 没有 dist/index.html,先跑: npm run build');
    process.exit(1);
  }
  const server = await serveDist();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const executablePath = resolveExecutablePath();
  if (!executablePath) {
    console.error('✖ 找不到可用的 Chrome,先跑: npx puppeteer browsers install chrome');
    server.close();
    process.exit(1);
  }
  console.log(`使用浏览器: ${executablePath}\n`);
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox'],
  });

  try {
    // ── macOS:四个步骤 ──
    {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(stub('darwin'));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      const s = await probe(page);
      check('macOS 渲染 4 个步骤', s.steps === 4, `实际 ${s.steps}`);
      check('macOS 保留「默认执行」', s.text.includes('默认执行'));

      // 点到第 3、4 步,确认这两个界面在 macOS 上真的还在
      const clickStep = async (index) => {
        await page.evaluate((i) => {
          const circles = [...document.querySelectorAll('div')]
            .filter((d) => typeof d.className === 'string'
              && d.className.includes('h-8') && d.className.includes('w-8')
              && d.className.includes('rounded-full'));
          const target = circles[i];
          if (target && target.parentElement) target.parentElement.click();
        }, index);
        await new Promise((r) => setTimeout(r, 500));
      };
      await clickStep(2);
      check('macOS 第 3 步是「模拟点击」(录制)', (await probe(page)).text.includes('模拟点击'));
      await clickStep(3);
      check('macOS 第 4 步是「键盘输入」(快捷输入)', (await probe(page)).text.includes('键盘输入'));
      await page.close();
    }

    // ── Windows:两个步骤(激活 / 键盘输入),没有「模拟点击」、没有「默认执行」──
    //
    // 2026-10-24:Windows 补上了「键盘输入」(拼音自动键入)这一步 ——
    // ADR-0012 明确 Windows 线**保留**「拼音自动键入」,而且后端通道是通的
    // (`win-input` 的 sendText 直接送 Unicode,不依赖 macOS 的输入源切换)。
    // 「模拟点击(录制)」仍然不出现(ADR-0012:Windows 线不做录制)。
    //
    // 同一天又撤掉了「默认执行(回放)」那一屏:Windows 没有录制 ⇒ 没有可回放的源
    // ⇒ 那一屏是「点了没反应」的死界面(用户口径:「本来就没有这个功能」)。
    {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(stub('win32'));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      const s = await probe(page);
      check('Windows 渲染 2 个步骤', s.steps === 2, `实际 ${s.steps}`);
      check('Windows 界面上没有「模拟点击」', !s.text.includes('模拟点击'));
      check('Windows 界面上没有「默认执行」(回放不做,那一屏是死界面)', !s.text.includes('默认执行'));
      check('Windows 界面上没有「选择录制」', !s.text.includes('选择录制'));
      check('Windows 界面上没有「管理」入口', !s.text.includes('管理'));
      check(
        'Windows 界面上没有红底白字横幅(原生模块没坏就不该报「加载失败」)',
        !s.text.includes('模拟输入相关功能不可用'),
      );

      // 第 2 步必须**真的是**「键盘输入」(拼音自动键入)——
      // 界面上有这一步 ≠ 这一步是能用的面板,所以点过去看一眼标题。
      // (body.innerText 只含**当前可见**的那一步,所以得点过去才看得到。)
      await page.evaluate(() => {
        const circles = [...document.querySelectorAll('div')]
          .filter((d) => typeof d.className === 'string'
            && d.className.includes('h-8') && d.className.includes('w-8')
            && d.className.includes('rounded-full'));
        const target = circles[1];
        if (target && target.parentElement) target.parentElement.click();
      });
      await new Promise((r) => setTimeout(r, 500));
      check('Windows 第 2 步是「键盘输入」(拼音自动键入)',
        (await probe(page)).text.includes('键盘输入'));
      await page.close();
    }

    // ── 原生模块真的坏了:红底白字横幅**必须出现** ──
    // 这条横幅不是死代码 —— 它只在 `nativeStatus.ok === false` 时出现。
    {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(stub('win32', {
        ok: false,
        platform: 'win32',
        error: '原生模块加载失败(测试桩)',
      }));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      const broken = await probe(page);
      check(
        '原生模块真坏了 ⇒ 红底白字横幅出现(而且写明原因)',
        broken.text.includes('模拟输入相关功能不可用')
          && broken.text.includes('原生模块加载失败(测试桩)'),
      );
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failed === 0 ? '\n✔ 界面裁剪自检全部通过' : `\n✖ ${failed} 项不通过`);
  process.exit(failed === 0 ? 0 : 1);
})();
