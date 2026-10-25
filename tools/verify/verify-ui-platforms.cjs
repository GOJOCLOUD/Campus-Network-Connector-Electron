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
    // 窗口动作的**调用记录**:用来断言右上角那四个按钮各自调了什么
    // (「关闭软件」= quit 一次点击真退出;「放到后台」= hide 进程留着)。
    window.__winCalls = [];
    // 键入请求的记录:用来断言「开始输入」带 3 秒倒计时。
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

      // ── 右上角只留**两个**按钮:最小化 / 叉叉(=终止)──
      //
      // 2026-10-25 用户口径(第二次,最终版):「把全屏按钮给我删除掉,最小化保留,
      // 然后叉叉也保留,你能不能搞个终止按钮,搞个叉车,两个就重复了呀,
      // 现在就保留两个,一个最小化,一个终止,终止的形状要叉叉,其他的都不要」。
      //
      // - **最小化**;
      // - **叉叉** = **终止**(形状就是叉叉;彻底退出,一次点击就退)。
      //
      // 被删掉的三个(都是用户明令,不是我们自己猜的):
      // - **最大化**(「把全屏按钮给我删除掉」);
      // - **关闭软件**(电源图标)—— 与叉叉**重复**(用户原话「搞个叉车,两个就重复了呀」);
      // - **放到后台** —— 窗口藏起来**仍然做得到**:Alt+F4 / 任务栏右键「关闭窗口」,
      //   回来靠**托盘图标**(左键)或再运行一次程序。
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
      check('Windows 右上角只有 2 个按钮', corner && corner.length === 2,
        corner ? corner.map((b) => b.aria).join(',') : '没找到右上角按钮组');
      check('两个按钮是「最小化 / 终止(叉叉)」',
        corner && corner.map((b) => b.aria).join(',') === '最小化,终止',
        corner ? corner.map((b) => b.aria).join(',') : '');

      // 点这两个按钮,看它们各自调的是哪个窗口动作。
      //
      // 关键:「**终止**」必须调 **quit** —— 一次点击就真退出
      // (用户口径:「人家真正想关软件还得点两次」⇒ 不能让他先去托盘再点一次);
      // **hide**(放到后台)**不该**再被右上角的按钮触发(那个按钮已按用户口径删掉)。
      await page.evaluate(() => {
        const host = [...document.querySelectorAll('.app-nodrag')].find((d) => {
          const c = typeof d.className === 'string' ? d.className : '';
          return c.includes('top-3') && c.includes('right-3');
        });
        [...host.querySelectorAll('button')].forEach((b) => b.click());
      });
      const calls = await page.evaluate(() => window.__winCalls);
      check('两个按钮分别调 minimize / quit',
        JSON.stringify(calls) === JSON.stringify(['minimize', 'quit']),
        JSON.stringify(calls));
      check('右上角**没有**「放到后台」(hide)按钮了(用户明令删掉)',
        !calls.includes('hide'), JSON.stringify(calls));

      // ── 「从剪贴板读入并键入」按钮**已经撤掉**(2026-10-25 用户口径)──
      //
      // 用户原话:「你这个界面本来就有开始输入这个按钮,只不过给了你三秒来定位光标在哪?
      // 你现在多加个按钮进去,那跟普通的界面有什么区别?我现在就是要快捷键触发呀」。
      //
      // ⇒ 这个能力回到 **⌃D 全局快捷键**,界面上不再有第二个按钮。
      const panelText = (await probe(page)).text;
      check('界面上**没有**「从剪贴板读入并键入」按钮(这个能力回到 ⌃D 快捷键)',
        !panelText.includes('从剪贴板读入并键入'));
      check('「开始输入（3s 后键入）」按钮还在(界面上唯一的输入入口)',
        panelText.includes('开始输入（3s 后键入）'),
        panelText.includes('开始输入') ? '' : '没找到「开始输入」按钮');
      // 点它:必须**带 3 秒倒计时**。
      // ⚠️ 点我们按钮的那一刻,焦点在**我们自己的窗口**里 —— 立刻键入的话,
      // 字会打进我们自己的界面,而不是用户想输入的目标软件。
      // (⌃D 全局键那条路不一样:它是**目标软件**在前台时按的,焦点本来就在那边,
      //  所以它可以立刻键入。)
      await page.evaluate(() => {
        const ta = document.querySelector('textarea');
        if (ta) {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, '测试文字');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await new Promise((r) => setTimeout(r, 200));
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => (b.textContent || '').includes('开始输入'));
        if (btn) btn.click();
      });
      await new Promise((r) => setTimeout(r, 300));
      const typed = await page.evaluate(() => window.__pinyinInputs);
      check('「开始输入」把内容送进键入通道',
        typed.some((p) => p[0] === '测试文字'), JSON.stringify(typed));
      check('「开始输入」带 3 秒倒计时(不是立刻键入)',
        typed.some((p) => p[0] === '测试文字' && p[1] === 3), JSON.stringify(typed));
      check('界面上有倒计时提示(用户要时间去把光标移到目标位置)',
        (await probe(page)).text.includes('秒后开始输入'));

      await page.close();
    }

    // ── ⌃D **抢没抢到**必须**看得见**(2026-10-25 用户口径)──
    //
    // 抢 ⌃D 的目的:在别的软件里按 Ctrl+D 时,那个软件**收不到**这个组合键,
    // 于是它不会被自己的「退出」关掉。
    //
    // 但注册是**系统级独占**的:别的软件先注册了同一个组合键 ⇒ 我们**抢不到**。
    // 抢不到时有两件事同时成立:
    //   ① 按它**不会触发我们**;
    //   ② 目标软件自己的 Ctrl+D **照常生效** ⇒ 那个软件还是会被它关掉。
    // 这两件用户必须知道,否则只会觉得「按了没反应,是不是软件坏了」。
    {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(stub('win32', {
        ok: true, platform: 'win32', shortcutPasteRegistered: false,
      }));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      // 提示行在「键盘输入」那一页 ⇒ 得点进去才看得到
      await page.evaluate(() => {
        const circles = [...document.querySelectorAll('div')]
          .filter((d) => typeof d.className === 'string'
            && d.className.includes('h-8') && d.className.includes('w-8')
            && d.className.includes('rounded-full'));
        const target = circles[1];
        if (target && target.parentElement) target.parentElement.click();
      });
      await new Promise((r) => setTimeout(r, 500));
      const lost = await probe(page);
      check('⌃D 没抢到 ⇒ 界面出现提示(说清楚按了不会触发我们)',
        lost.text.includes('没抢到'), lost.text.includes('没抢到') ? '' : lost.text.slice(0, 160));
      check('⌃D 没抢到的提示里说清了「目标软件自己的 Ctrl+D 照常生效」',
        lost.text.includes('照常生效'), '');
      await page.close();
    }
    // 抢到了 ⇒ **不该**出现那条提示(别一上来就吓人)
    {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(stub('win32', {
        ok: true, platform: 'win32', shortcutPasteRegistered: true,
      }));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      await page.evaluate(() => {
        const circles = [...document.querySelectorAll('div')]
          .filter((d) => typeof d.className === 'string'
            && d.className.includes('h-8') && d.className.includes('w-8')
            && d.className.includes('rounded-full'));
        const target = circles[1];
        if (target && target.parentElement) target.parentElement.click();
      });
      await new Promise((r) => setTimeout(r, 500));
      const won = await probe(page);
      check('⌃D 抢到了 ⇒ 界面没有那条提示',
        !won.text.includes('没抢到'), '');
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

    // ── Windows 线**只抢 ⌃⇧D**,不抢 ⌃S(源码级断言)──
    //
    // 2026-10-25 用户口径:「干脆直接把系统的抢了,我的软件优先级最高……
    // Ctrl 加 D 我发现在普通桌面它是退出软件的功能,那在使用这个的时候
    // 没必要退出吧,所以就给他压制住」+「你不要用ctrl+D了,直接ctrl+shift+D吧」。
    //
    // - **⌃⇧D** = 读剪贴板并键入 —— 我们抢的就是它(抢到手,别的软件就收不到);
    // - **⌃S** = 默认执行(回放)—— Windows 上那一屏**已经没有界面了**
    //   (ADR-0016),而 Ctrl+S 在别的软件里是「保存」⇒ **不抢**。
    //
    // 这条**只能在源码里查**:界面上看不出"系统里注册了哪些全局键"。
    {
      const mainJs = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
      // 查的是**开关常量**:注册那条路一直在,开关决定它跑不跑。
      const switchOn = /const GLOBAL_SHORTCUTS_ENABLED\s*=\s*true/.test(mainJs);
      check('Electron 的全局快捷键开关是**开**的(⌃⇧D 要抢)',
        switchOn,
        switchOn ? 'GLOBAL_SHORTCUTS_ENABLED = true' : '没找到 GLOBAL_SHORTCUTS_ENABLED = true');
      // 注册的**键**必须只有 ⌃⇧D。
      const regD = /globalShortcut\.register\(\s*'Ctrl\+Shift\+D'/.test(mainJs);
      check('Electron 注册了 ⌃⇧D(要抢的就是它)', regD, regD ? '' : "没找到 register('Ctrl+Shift+D')");
      // **不能**还留着 ⌃D:用户明确要求换键(而且 ⌃D 在别的软件里是「退出」那一族)。
      const regPlainD = /globalShortcut\.register\(\s*'Ctrl\+D'/.test(mainJs);
      check('Electron **没有**再注册 ⌃D(用户口径:改用 ⌃⇧D)', !regPlainD,
        regPlainD ? "居然还注册着 'Ctrl+D'" : '');
      const regS = /globalShortcut\.register\(\s*'Ctrl\+S'/.test(mainJs);
      check('Electron **没有**注册 ⌃S(默认执行:Windows 那屏已撤,且 Ctrl+S 是「保存」)',
        !regS, regS ? '居然注册了 Ctrl+S' : '');
      // 「抢没抢到」要能被界面读到 ⇒ 原生状态里必须有这一栏。
      check('原生状态里有「shortcutPasteRegistered」这一栏(界面靠它显示提示)',
        /shortcutPasteRegistered\s*:/.test(mainJs));
    }

    // ── 最后一页必须有**浏览器修复的说明块**(Windows 线)──
    //
    // 用户 2026-10-25:「在windows上那个把密文转化成明文的那个功能是失效的,
    // 没有用的」「最后个页面的相关提示也和macOS上面的两个版本完全不同」。
    //
    // Windows 上的浏览器修复由 **Chrome/Edge 扩展**提供(桌面程序接管不了浏览器),
    // 所以界面上给的是**说明块**而不是开关 —— 但**必须有**,
    // 否则用户根本不知道这个功能在哪、怎么用 ⇒ 等于没有。
    {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(stub('win32', { ok: true, platform: 'win32' }));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      // 点到第 2 步(键盘输入)—— Windows 只有两步:激活 / 键盘输入
      await page.evaluate(() => {
        const circles = [...document.querySelectorAll('div')]
          .filter((d) => typeof d.className === 'string'
            && d.className.includes('h-8') && d.className.includes('w-8')
            && d.className.includes('rounded-full'));
        const target = circles[1];
        if (target && target.parentElement) target.parentElement.click();
      });
      await new Promise((r) => setTimeout(r, 500));
      const last = await probe(page);
      check('Windows 最后一页有「浏览器修复(复制修复)」说明块',
        last.text.includes('浏览器修复') && last.text.includes('复制修复'),
        last.text.includes('浏览器修复') ? '' : last.text.slice(0, 200));
      check('说明块说清楚了它由 Chrome / Edge 扩展提供',
        /Chrome\s*\/\s*Edge|chrome:\/\/extensions/.test(last.text), '');
      check('说明块给出了加载扩展的入口(chrome://extensions)',
        last.text.includes('chrome://extensions'), '');
      check('说明块告诉了用户扩展文件夹在哪儿(browser-extension)',
        last.text.includes('browser-extension'), '');
      // **不该**出现 mac 的「Safari 复制修复」开关(Windows 上没有 Safari)。
      check('Windows 最后一页**没有** mac 的「Safari 复制修复」开关',
        !last.text.includes('Safari 复制修复'), '');
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failed === 0 ? '\n✔ 界面裁剪自检全部通过' : `\n✖ ${failed} 项不通过`);
  process.exit(failed === 0 ? 0 : 1);
})();
