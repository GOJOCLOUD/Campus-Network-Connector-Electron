# ADR-0013:Windows 线与 macOS 线行为对齐(⌃S / ⌃D、latch、录制排除矩形、CI 门禁)

- 状态:**已定**(Windows 线已实现)
- 日期:2026-10-24
- 相关:ADR-0012(平台功能范围)、ADR-0003(原生模块必须 asarUnpack)、
  `mac` 分支的 ADR-0013(快捷键 ⌃S/⌃D 与 latch)、`mac` 分支的 ADR-0014(打包白名单漏文件)
- 性质:**两条产品线的行为口径**。冲突时以本文件为准,mac 分支的对应文档另行同步。

## 背景

`mac` 分支(macOS 产品线)与 `win` 分支(Windows 产品线)是**同一个仓库的两条独立发布线**,
CI 按分支出包。历史原因,两边在**同一功能**上的行为对不齐:

| 功能 | mac 分支(2026-10-23 之后) | win 分支(本轮之前) |
| --- | --- | --- |
| 快捷键 | ⌃S / ⌃D | ⌃⇧A / ⌃⇧D |
| latch(触发一次被消费掉) | 有 | **没有** |
| ⌃D 剪贴板直输 | 有 | **压根没注册** |
| 换页时内容区底下的横向滚动条 | 已修 | **还在**(用户报过的 bug) |
| 录制排除矩形 | 主进程按窗口位置算 | 前端传一张会过期的快照 |
| 录制的单条删除 | 有 | **没有** |
| CI 门禁 | 5 条 | 只有 2 条 |

同一件事,用户在两个系统上得到两种行为 —— 这不是"平台差异",是**没做完**。

⇒ 本轮把 Windows 线**按行为**对齐到 mac 线。

## 一、口径:什么算"对齐"

**对齐 = 同一个功能,用户看到的结果与操作路径一致**,不是"两个平台的代码长得一样"。

具体拆成三层:

1. **规则层**:状态机、判定口径、门禁断言 —— **逐字相同**。
   可跨平台的纯 JS 资产(`shortcut-latch.cjs`、`playback-guard.cjs`、四条 `verify-*.cjs`)
   在两条分支之间**字节相同**,改一边就要改另一边。
2. **机制层**:实现方式可以不同 —— mac 用 CGEventTap,Windows 用 `GetAsyncKeyState` 轮询;
   但**对外调用形态一致**(`nativeCall('watchControlKey', cb)`),
   降级行为也一致(拿不到就如实降级 + 打 warn,**不假装生效**)。
3. **产品差异层**:平台**必需**的差异(辅助功能授权、Safari 复制修复、输入源切换)保留,
   但要用**显式的形状**表达,而不是"没传那个 prop"。

## 二、latch:规则两边一字不差

```
触发                ⇒ armed = false 且 blocked = true
Control 松开        ⇒ blocked = false、armed = true      (彻底解锁)
Control 按下        ⇒ 只有 blocked == false 时才 armed = true
```

规则出自用户原话(2026-10-23):

> 「触发之后 Ctrl+D 整个按键就不再会继续影响它了,除非下一次重新按住 Ctrl,再点击相应的字母」

**为什么"Control 按下"不能无条件解锁**:系统热键的回调与只读观察的回调**谁先到不确定**;
主键的 keydown 也可能先于修饰键事件到达。若那一下能无条件解锁 ⇒ latch 白设 ⇒
**按住 Ctrl 连按会连着触发** ⇒ 而「默认执行」是**回放** ⇒ 往用户屏幕上乱点一串合成点击。

⇒ `blocked` 只能由「Control 松开」来清。

### Windows 上怎么观察 Control 的按下/松开

`win-input` 新增 `watchControlKey`,**对外形态与 mac 侧一致**:

```js
const watched = nativeCall('watchControlKey', (ctrlDown) => latch.onCtrlChange(ctrlDown));
const canLatch = watched === true;   // false ⇒ 如实降级 + warn
```

机制:用 `GetAsyncKeyState(VK_CONTROL)` **轮询**(25ms 一次)做**边沿检测**,状态变化才回调。

- **为什么不用低级键盘钩子**:`GetAsyncKeyState` 读的是**物理键盘状态**,
  **不受 `RegisterHotKey` / globalShortcut 注册影响** ⇒ 组合键被系统热键吞了,
  也照样拿得到 Control 的真实按下/松开;
  而 `WH_KEYBOARD_LL` 有 LowLevelHooksTimeout 风险 —— 钩子回调一卡就被系统摘掉,
  **丢一次边沿就等于 latch 解不开**(用户再也触发不了快捷键)。
- **线程生命周期**:停止靠标志 + join,并挂在 N-API 的 env 清理钩子上 ⇒
  进程退出时不留野线程,也不吊住 Node 事件循环。

> ⚠️ **mac 分支 ADR-0013 里"Windows 线没有 latch"那一段已过期**:
> 那是本轮之前的状态。本文件为准。

## 三、⌃D 在 Windows 上做什么

| | macOS | Windows |
| --- | --- | --- |
| 读剪贴板 | ✅ | ✅(同构) |
| 读设置里 textbox 的固定文本 | ✅ | ✅(同构) |
| 空文本不动作 | ✅ | ✅(同构) |
| **切 ASCII 输入源** | ✅(拼音键入需要 ASCII 布局) | ❌ **不做** |
| 逐字键入 | CGEventPost | `win-input` 的 `sendText`(WM_CHAR / KEYEVENTF_UNICODE) |

Windows **没有「输入源」这个概念** ⇒ `sendText` 直接送 Unicode ⇒
切输入源不但没必要,还会把用户正在用的输入法状态搅乱 ⇒ **跳过那一段,其余流程与 mac 同构**。

### 与「键盘输入」页(拼音自动键入)的关系:**不冲突**

- 「键盘输入」页:用户**手动**在输入框里敲内容,点「开始输入」才键入;
- ⌃D:把**剪贴板**(或设置里那段固定文本)的内容**直接**敲进去,不需要用户先敲。

⇒ 两个入口,两个数据来源,互不替代。

### 前端那条 `onKeyDown` 为什么在 Windows 上不生效

`src/App.jsx` 的 `onKeyDown` 里,⌃D 那一条**保留**了 mac 分支的 `&& !isWindows`。
这是刻意的:

- 全局快捷键(主进程 `globalShortcut.register('Ctrl+D')`)**已经**覆盖了 ⌃D;
- 两条路都生效 = 剪贴板内容被**键入两遍**。
- 保留这个条件 ⇒ 两个分支的这几行**逐字一致**,以后加功能的人不会漏看。

> 全局注册失败(快捷键被别的程序抢走)时,主进程那条路兜底;
> mac 分支的同一处也是这个结构。

## 四、平台差异清单(保留,不改)

| 能力 | macOS | Windows | 性质 |
| --- | --- | --- | --- |
| 界面步骤数 | **4 步**:激活 → 默认执行 → 模拟点击 → 键盘输入 | **3 步**:激活 → 默认执行 → **键盘输入** | 平台必需(Windows 不做录制) |
| 「模拟点击(录制)」入口 | 有 | **不出现**(原生层有 `WH_MOUSE_LL` 的能力,但按 ADR-0012 不作为正式功能开放) | 平台必需 |
| 「键盘输入(拼音自动键入)」入口 | 有 | **有** —— Windows 的 `sendText` 直接送 Unicode(WM_CHAR / KEYEVENTF_UNICODE),不依赖输入源切换 | **已对齐**(ADR-0012 明确 Windows 保留这一项) |
| 「辅助功能」授权 | 需要,界面显示小问号 | **不需要**(SendInput 不需要授权) | 平台必需 |
| 「辅助功能」小问号的写法 | `showAccessibilityBadge: isMac` | `showAccessibilityBadge: isMac` | **逐字相同**(`isMac` 在 Windows 上恒为 `false` ⇒ 小问号不出现) |
| 快捷键 / latch 的诊断字段 | `native:getStatus` 返回 5 栏(`shortcutCtrlS` / `shortcutCtrlD` / `latchAvailable` / `latchArmed` / `controlWatcherRunning`) | 同 5 栏,**同名同义** | **已对齐**(2026-10-24 把 mac 侧补齐) |
| Safari 复制修复 | 有 | 无(无 Safari) | 平台必需 |
| 输入源切换 | 有 | 无 | 平台必需 |
| 录制 | CGEventTap | `WH_MOUSE_LL` 低级鼠标钩子 | 机制不同,行为一致 |
| Control 边沿观察 | CGEventTap ListenOnly | `GetAsyncKeyState` 轮询 | 机制不同,行为一致 |

**"显式"是什么意思**:Windows 侧**显式**写出这个形状(`showAccessibilityBadge: isMac`),
而不是"没传那个 prop"。⇒ 两个分支的 `App.jsx` **逐字相同**
(`isMac` 在 Windows 上恒为 `false`,所以小问号不出现 —— 值不同,写法相同)。

> 2026-10-24 更正:本节原来写的是「Windows 侧显式传 `showAccessibilityBadge={false}`」。
> 那是为了对齐**形状**临时写的字面量;现在两边统一成 `isMac`,
> 两个分支的 `App.jsx` **逐字节相同** ⇒ 这一行不再是平台差异。

### 4.1 「完成」按钮:Windows 为什么也显示

最后一步点「完成」会把**整个面板收起**(`isCompleted` → 高度 0),
收起后还能靠顶上的步骤圈点回来。

- **以前** Windows 只有两步,最后一步正是主操作界面「默认执行」——
  那一屏被收起就没法操作了 ⇒ `hideCompleteButton={isWindows}` 把按钮藏了。
- **现在**(2026-10-24 补上「键盘输入」这一步)Windows 的最后一步是「键盘输入」,
  和 macOS 一样**不是**主操作界面 ⇒ **照常显示**,与 macOS 行为一致
  (`hideCompleteButton={false}`)。

「管理录制文件」的入口**仍然**挂在「默认执行」那一步(`showManage: isWindows`):
它管的是录制文件,和「键盘输入」没关系 —— Windows 上没有「模拟点击」那一步可挂。

### 4.2 录制那条:原生层对齐了,界面入口仍然没有

本轮把**录制链路**按 mac 的形状对齐了(排除矩形由主进程算、单条删除、
`stopRecording` 不清空)—— 那是**代码形状**的对齐。
但**界面入口**在 Windows 上仍然不出现(ADR-0012:Windows 线不做录制)。

⇒ 也就是说:Windows 上那套录制代码是**备着但没开**的。
真要开,得先给 ADR-0012 改口径(那是**加功能**,要单独授权),不是本轮的事。

## 五、取舍与风险

### ⚠️ 风险 ①:Windows 上全局注册 ⌃S / ⌃D 会抢走别的应用的同名快捷键

**必须写进留档**:Windows 的习惯是 **Ctrl+S 保存、Ctrl+D 收藏书签**;
macOS 那边用 **⌘S / ⌘D**,习惯不同,所以影响小。
本 App 在 Windows 上**全局**注册这两个组合 ⇒ **别的应用里按 Ctrl+S / Ctrl+D 也会被本 App 吃掉**
(那一下本 App 不会执行动作,但对方的应用也收不到了)。

这是"两边逻辑一致"**必然**带来的副作用 —— 不是 bug,是取舍。

**如果将来用户反馈冲突**:改成 `Control+Shift+S` / `Control+Shift+D` 是**一行的事**
(`main.js` 的 `registerShortcuts()` 里两个字符串 + `src/App.jsx` 的两个 `e.code` 判断)。

### 风险 ②:Windows 的 latch 依赖轮询,不是事件

轮询间隔 25ms ⇒ 用户松开 Control 之后**最多晚 25ms** 才解锁(无感);
但理论上存在"极快地松开又按下"被漏掉一次边沿的可能 ⇒ 那种情况下 latch 多锁一会儿
(用户再松一次 Control 即可)。比"丢边沿 ⇒ 永远锁死"好得多 ——
这正是选轮询而不选低级钩子的原因(钩子被系统摘掉 = 永久丢边沿)。

### 风险 ③:录制排除矩形依赖主进程在窗口移动时刷新

排除矩形由**主进程**按 `BrowserWindow.getBounds()` 算,窗口每次 move/resize 刷新一次。
主进程忙的时候刷新会晚几十毫秒 ⇒ 极端情况下"点自己界面的按钮"可能被记成一次点击。
这是**已知代价**(换来的是"窗口动了之后排除矩形依然准确")。

### 风险 ④:移植共享层的 `page-guard.ts` / `frame-bridge.ts`

为了让 CI 门禁"页面守卫的回归测试"在 Windows 线上**有意义且能过**,
本轮把 `mac` 分支的 `packages/browser-adapters/shared/src/page-guard.ts` 与
`frame-bridge.ts` 整文件移植到 `win` 分支。

- 这两个文件在 Windows 的 **Electron 包里根本没进包**(`safari-repair` 是 `platforms: ['darwin']`);
- 但它们是**浏览器扩展**用的共享层 ⇒ 移植过去顺带把 ADR-0017 的修复
  ("换题后复制出密文")带到了 `win` 分支的扩展上;
- 共享层的协议(`protocol.ts`)两边**逐字相同** ⇒ 没有额外的适配成本。

## 六、回归(门禁)

Windows 线的 CI(`build-windows.yml`)现在跑**与 mac 同级**的门禁,
全部在**打包之前**,跑不过就不发包:

| 门禁 | 盯什么 |
| --- | --- |
| `verify-frame-bridge.cjs` | 换题之后映射还能不能送到新那层 frame |
| `verify-page-guard.cjs` | 页面守卫:字体变了才重扫、送到了就不重报 |
| `verify-panel-transition.cjs` | 换页时内容区**底下**不许再出现横向滚动条 |
| `verify-recording-ui.cjs` | 录制的单条删除 + 开始录制不传那张会过期的矩形 |
| `verify-playback-guard.cjs` | 回放的重入保护(T0 事故的底线闸) |
| `verify-shortcut-latch.cjs` | latch:触发一次被消费掉,Control 不松开不许再触发 |
| `verify-package-win.cjs` | 打包产物:原生模块解包、**包内所有相对 require 都能解析** |

最后一条是 mac 侧 ADR-0014 的第一层门禁 ——
**本轮在 win 分支上补上了**(之前没有),而且它当场抓到了一个真问题:
`build.files` 白名单里**漏了 `playback-guard.cjs`**,而 `main.js` 顶层就要 `require` 它
⇒ 那个包**装上即崩**。`shortcut-latch.cjs` 本轮新增,同样进了白名单。

### 找浏览器的逻辑必须是**唯一入口**

界面层那几条门禁要真的开一个浏览器(puppeteer)。这段"找 Chrome"的逻辑
曾经被**复制在多个文件**里,改一处忘一处就会漂移 ——
2026-10-24 Windows CI 第一次跑这些用例就是这么红的:
那段代码只认 `process.env.HOME`,而 **Windows 上没有 `HOME`**
(只有 `USERPROFILE` / `LOCALAPPDATA`)⇒ 拼出来是个**相对路径**
`.cache/puppeteer` ⇒ 断言"找不到 Chrome"⇒ 门禁变红
—— 而**门禁本身没毛病**,是它找不到浏览器。

⇒ 抽成 **`tools/chrome-path.cjs`**(唯一入口,跨平台):
`PUPPETEER_EXECUTABLE_PATH` → `puppeteer.executablePath()` →
手动扫各平台缓存目录(mac / Linux / Windows)→ Windows 再兜底找系统自带 Edge / Chrome。
所有测试脚本只 `require` 它,不再各写一份。

**教训**:门禁红的时候,先分清是**门禁本身坏了**还是**门禁的前置条件没满足** ——
这次是后者。抽成唯一入口比在每个文件里各修一遍更省事,也更不容易再漂。

## 七、教训

**"平台差异"要分清"平台必需"和"没做完"。** 之前两条线行为对不齐,
一部分是**平台必需**(辅助功能、Safari),一部分只是**没做完**。
把后者当"平台差异"写进文档,就会一直对不齐。

**能跨平台的纯 JS 资产,两边必须字节相同。** 规则、状态机、门禁断言写两遍,
迟早会漂。改一边就要改另一边,并且用 `diff` 校验。

**门禁要在"打包之前"。** 装上即崩这类问题,只有在打包那一刻拦才拦得住
(事后人工复现的成本高得多)。
