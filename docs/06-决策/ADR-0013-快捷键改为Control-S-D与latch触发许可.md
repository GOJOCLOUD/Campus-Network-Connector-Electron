# ADR-0013:快捷键改成 ⌃S / ⌃D,并加 latch(触发一次就被消费掉)

- 状态:已定(Electron / macOS 已实现)
- 日期:2026-10-23
- 相关:ADR-0012(平台功能范围)、ADR-0013(Tauri 仓库同名决策:ADR-0024)
- ⚠️ 本仓库的 ADR 编号只排到 0012;Tauri 仓库那边同名决策是 **ADR-0024**
  (以及 ADR-0022「吞键」、ADR-0023「顺序无关」)。**规则两边一字不差。**

## 背景

用户原话(2026-10-23):

> 「不行,这整个机制还是有问题,**不要 shift 了,直接 ctrl 吧**,只要按住 Ctrl
> 再加一个 D,它就可以成功触发,然后默认执行的 Ctrl+shift+a 呢,也就换成我看一下
> **ctrl+S** 吧,**两个框架版本的都要换**,注意是摁住 Ctrl 的条件下点击 D 就触发,
> 然后**触发之后 Ctrl 加 D 整个按键就不再会继续影响它了,除非下一次重新按住 Ctrl,
> 再点击相应的字母**」

两个独立要求:**① 键位改成 ⌃S / ⌃D(去掉 Shift);② latch(触发一次被消费掉)。**

> 原文「⌃⇧A 换成 ⌃S」里去掉的是 **Shift**,不是把 ⌃ 换成 ⌘ ——
> 界面文案一直是 `Control+…`。

---

## 一、键位 = ⌃S / ⌃D

| 快捷键 | 动作 | 平台 |
| --- | --- | --- |
| **⌃S** | 「默认执行」= 回放选中的录制文件 | macOS / Windows |
| **⌃D** | 读剪贴板(或输入框里固定的那段文本)并逐字键入 | 只有 macOS |

Electron 侧注册:

```js
globalShortcut.register('Ctrl+S', ...)   // 默认执行
globalShortcut.register('Ctrl+D', ...)   // 剪贴板直入(仅 darwin)
```

**只认 Control**:⌘S 是「保存」、⌘D 是「书签」,不能抢。

---

## 二、latch:触发一次就被"消费掉"

### 规则(Tauri 侧一字不差)

```
触发                ⇒ armed = false 且 blocked = true
Control 松开        ⇒ blocked = false、armed = true      (彻底解锁)
Control 按下        ⇒ 只有 blocked == false 时才 armed = true
```

### 为什么"Control 按下"不能无条件解锁

系统热键的回调与只读监听的回调**谁先到不确定**;主键的 keydown 也可能
**先于**修饰键的 `FlagsChanged` 到达(见 Tauri 仓库 ADR-0023 描述的乱序场景)。

若那一下"Control 按下"能无条件解锁 ⇒ latch 白设 ⇒
**按住 Ctrl 连按 D 会连着触发** ⇒ 而「默认执行」是**回放** ⇒
往用户屏幕上乱点一串合成点击。

⇒ **`blocked` 只能由「Control 松开」来清。**

### 为什么需要 latch

`globalShortcut` 只在按下时回调,**不告诉你 Control 什么时候松开**;
按住 Ctrl 时键盘自动重复还会**连着回调** ⇒ 一次误触可能连放好几遍。

---

## 三、Electron 侧怎么做到"知道 Control 松开了"

### `globalShortcut` + 一个 **ListenOnly 会话级 tap**

`globalShortcut` **不告诉你 Control 松开** ⇒ 另开一个只读监听
(`CGEventTapCreate` + `kCGEventTapOptionListenOnly` + 只听 `kCGEventFlagsChanged`)
观察 Control 的**按下/松开边沿**,喂给 latch 状态机。

- **ListenOnly 不需要「辅助功能」权限**(会话级只读监听是例外)——
  本 App 是 ad-hoc 签名,拿不到那个权限,而 `globalShortcut` 不需要 ⇒ 这条路能走;
- 本机实测 `watchControlKey` 返回 `true`(tap 建起来了);
- **只用它"看",不用它"吞"** —— 吞键交给系统热键做。

### 为什么不改成自建主动 tap

主动 tap(能吞键)**需要「辅助功能」权限**,Electron 是 ad-hoc 签名 ⇒ 拿不到。
`globalShortcut` 由系统替你吞键 ⇒ 既不漏按键、也不需要权限。

> ADR-0013(Tauri 仓库)约束的是**界面层**逐字照搬;机制不同有先例
> (ADR-0020 的 Carbon TIS 那条线两边机制就不同)。

### 拿不到只读监听 ⇒ **如实降级**

`watchControlKey` 返回 false ⇒ `canLatch = false` ⇒ 打一条 warn,
维持旧行为(按住 Ctrl 连按会连着触发)。**不假装 latch 生效。**

---

## 四、诚实的边界

### ① Windows 线**没有 latch**

`win-input` 模块里**没有**这个只读监听 ⇒ Windows 上 `canLatch` 恒为 false。
这是**平台差异**,不是遗漏。

### ② `win` 分支本轮**没动**

Windows 包在 `win` 分支上(与 `mac` 分支独立,CI 按分支出包)⇒
**Windows 包仍是 ⌃⇧A / ⌃⇧D,也没有 latch**。是否同步需单独一轮方案。

### ③ latch 挡的是**触发**,不是"没发生"

锁着的时候,系统热键照样吞掉按键(不往前台漏),只是**不执行动作**。

---

## 五、回归

- `node --test tools/verify/verify-shortcut-latch.cjs`:**4/4**(本轮新增)
  —— latch 状态机抽成 `shortcut-latch.cjs`(纯函数,与 `playback-guard.cjs` 同一个套路),
  **已挂进 CI 的硬门禁**(跑不过就不发包)。
- `node --test tools/verify/verify-playback-guard.cjs`:**4/4**(未受影响)。
- 原生模块(`mac-coregraphics`)编译通过;`watchControlKey` 冒烟返回 `true`。
- 变异自检(base 先绿 → 变体被抓住 → 还原复绿):

  | 变体 | 被哪条抓住 |
  | --- | --- |
  | M1:Control 按下时**不看 blocked**就武装 | `迟到的「Control 按下」不能解除 latch` |
  | M2:触发后**不记 blocked** | 同上 |

  ⚠️ 自检**不发任何系统级键盘/鼠标事件** —— 全是进程内的纯函数单测。

---

## 六、教训

**latch 这类"手感",必须两边同一份规则。** 第一版实现里 Tauri 侧是
「Control **按下**才武装」、Electron 侧是「Control **松开**才武装」——
同一个功能、两套语义,用户会拿到两种手感。
⇒ 先定规则,再各写各的适配;规则写进 ADR,两边照抄。

**"事件回调谁先到"是不确定的。** 任何"靠事件解除的锁",都必须扛得住
**迟到的那一个**。

---

## 七、待办(需要单独一轮方案,不在本轮)

- **`win` 分支要不要同步本轮改动**(键位 + latch);
- **Windows 线要不要补 latch**(需要 Win32 侧的 Control 边沿观察);
- Electron / Tauri 的 `executed` 计数口径不一致。
