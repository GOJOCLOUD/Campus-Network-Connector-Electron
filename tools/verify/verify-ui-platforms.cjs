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
    // 窗口动作的**调用记录**:用来断言右上角那三个按钮各自调了什么
    // (特别是「关闭」必须调 hide 而不是 quit —— 那是「后台挂着」的关键)。
    window.__winCalls = [];
    // 键入请求的记录:用来断言「从剪贴板读入并键入」真把剪贴板的字送进去了。
    window.__pinyinInputs = [];
    window.cnc = {
      platform: ${JSON.stringify(platform)},
      quit() { window.__winCalls.push('quit'); },
      minimize() { window.__winCalls.push('minimize'); },
      maximize() { window.__winCalls.push('maximize'); },
      hide() { window.__winCalls.push('hide'); },
      clipboardReadText: async () => '来自剪贴板的文字',
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
      pinyinInput: async (text, delay, autoSwitch) => {
        window.__pinyinInputs.push([text, delay, autoSwitch]);
        return { status: 'success' };
      },
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

      // ── 右上角必须是**三个**按钮:最小化 / 最大化 / 关闭 ──
      //
      // 2026-10-24 用户口径:「把它右上角做一个三个按钮,就是最大化最小化
      // 或者说直接关掉,别只留一个关掉的按钮」。
      const corner = await page.evaluate(() => {
        const host = [...document.querySelectorAll('.app-nodrag')].find((d) => {
          const c = typeof d.className === 'string' ? d.className : '';
          return c.includes('top-3') && c.includes('right-3');
        });
        if (!host) return null;
        return [...host.querySelectorAll('button')].map((b) => ({
          aria: b.getAttribute('aria-label') || '',
          title: b.getAttribute('title') || '',
        }));
      });
      check('Windows 右上角有 3 个按钮', corner && corner.length === 3,
        corner ? corner.map((b) => b.aria).join(',') : '没找到右上角按钮组');
      check('三个按钮是「最小化 / 最大化 / 关闭」',
        corner && corner.map((b) => b.aria).join(',') === '最小化,最大化,关闭',
        corner ? corner.map((b) => b.aria).join(',') : '');

      // 点这三个按钮,看它们各自调的是哪个窗口动作。
      //
      // 关键一条:**「关闭」必须是 hide 而不是 quit** ——
      // quit = 直接退进程(用户不接受:「他就直接完全退出了」),
      // hide = 只把窗口藏起来,进程留着(「要在后台挂着,功能依然生效」)。
      await page.evaluate(() => {
        const host = [...document.querySelectorAll('.app-nodrag')].find((d) => {
          const c = typeof d.className === 'string' ? d.className : '';
          return c.includes('top-3') && c.includes('right-3');
        });
        [...host.querySelectorAll('button')].forEach((b) => b.click());
      });
      const calls = await page.evaluate(() => window.__winCalls);
      check('三个按钮分别调 minimize / maximize / hide',
        JSON.stringify(calls) === JSON.stringify(['minimize', 'maximize', 'hide']),
        JSON.stringify(calls));
      check('「关闭」不是退出(没有调 quit)',
        !calls.includes('quit'), JSON.stringify(calls));

      // ── 「从剪贴板读入并键入」:⌃D 全局键撤掉后,这个能力从这里进 ──
      //
      // 不只是"按钮在不在",还要**真能把剪贴板的字送进键入通道**。
      const panelText = (await probe(page)).text;
      check('「键盘输入」页有「从剪贴板读入并键入」按钮',
        panelText.includes('从剪贴板读入并键入'));
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => (b.textContent || '').includes('从剪贴板读入并键入'));
        if (btn) btn.click();
      });
      await new Promise((r) => setTimeout(r, 300));
      const pasted = await page.evaluate(() => window.__pinyinInputs);
      check('「从剪贴板读入并键入」真把剪贴板里的文字送进了键入通道',
        pasted.some((p) => p[0] === '来自剪贴板的文字'), JSON.stringify(pasted));
      // ⚠️ 必须**等 3 秒**再键入,不能立刻:
      // 点我们按钮的那一刻,焦点在**我们自己的窗口**里 —— 立刻键入的话,
      // 字会打进我们自己的界面,而不是用户想输入的目标软件。
      check('「从剪贴板读入并键入」带 3 秒倒计时(不是立刻键入)',
        pasted.some((p) => p[0] === '来自剪贴板的文字' && p[1] === 3), JSON.stringify(pasted));
      check('界面上有倒计时提示(用户要时间去把光标移到目标位置)',
        (await probe(page)).text.includes('秒后开始输入'));

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

    // ── Windows 线**不注册任何全局快捷键**(源码级断言)──
    //
    // 2026-10-24 用户口径:⌃D 是 **Windows 的系统默认键** —— 我们抢过来,
    // 用户在自己常用的软件里按 ⌃D,那个软件/系统对话框会**直接被关掉**
    // (用户原话:「我不能设置为快捷键,不然他直接把软件退出了」)。⌃S 同理。
    //
    // 这条**只能在源码里查**:界面上看不出"系统里注册了哪些全局键"。
    {
      const mainJs = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
      // 查的是**开关常量**,不是"调用点消失":注册那条路还在,被这个开关挡着。
      // (同一个开关也管着 Control 轮询观察器 —— 它只服务于全局键的 latch。)
      const switchOff = /GLOBAL_SHORTCUTS_ENABLED\s*=\s*false/.test(mainJs);
      check('Electron 不注册任何全局快捷键(开关是关的)',
        switchOff,
        switchOff ? 'GLOBAL_SHORTCUTS_ENABLED = false' : '没找到 GLOBAL_SHORTCUTS_ENABLED = false');
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failed === 0 ? '\n✔ 界面裁剪自检全部通过' : `\n✖ ${failed} 项不通过`);
  process.exit(failed === 0 ? 0 : 1);
})();
