# 服务端 TUI 改造 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把代理服务器终端输出改为 TUI 布局——二维码常驻固定头部，日志在下方滚动，从而让「重连时扫不到码」和「出问题时日志已滚走」这两个同源痛点一并解决。

**Architecture:** 用 alt screen（`\x1b[?1049h`）+ 终端滚动区域（`\x1b[top;bottomr`）实现「头部固定、底部滚动」。头部占满屏幕顶部一段，其余区域设为滚动区，日志行直接 `write`，由终端自行在区域内滚动，**不维护日志缓冲区**（仅保留 200 行环形缓冲用于 resize / 切换时的回填）。`Utils.log` 保持签名不变、内部改为委托可替换 sink，因此 5 个既有日志调用点一行不动。

**Tech Stack:** TypeScript、Node.js（`process.stdout` / `stdin` TTY API）、手写 ANSI 转义序列、rollup（既有构建）。**不新增任何依赖。**

**Spec:** `docs/superpowers/specs/2026-10-09-tui-refactor-design.md`（实现前请先读该文档）

## Global Constraints

- **零新增依赖**，运行时与开发时都不加。`dist/server.js` 必须仍是零运行时依赖的单文件产物（当前 77KB）
- **改动限于 4 个文件**：`src/server/tui.ts`（新增）、`src/server/utils.ts`、`src/server/server.ts`、`src/server/index.ts`
- **`src/index.ts`（小程序端库）完全不动**。它的 `console.log` 进支付宝 IDE 控制台，没有 TUI 载体
- **不改二维码载荷格式**。`xlmpaas://<appId>?url=<encoded>` 是 `miniapp/utils/urlParser.js` 的契约
- **不新增测试设施**。项目无 test 脚本、devDeps 无测试框架，本次不加。验证依赖 `npm run type-check`、`npm run build`，以及用**已安装的 `tsx`** 执行临时断言（`npx tsx -e "..."`），断言脚本不落盘
- **代码风格**：`src/server/*.ts` 分号风格；注释简体中文；与既有文件保持一致
- **提交格式**：`<type>(scope): <summary>`，summary 中文、动词开头、≤50 字、不加句号
- **工作分支**：`feature/tui-refactor`（已创建，spec 已在其中提交）
- **不得虚构验证结果**：每步验证命令必须真实执行并核对输出
- **不要动态生成转义序列的语义**：ANSI 常量集中定义在 `tui.ts` 顶部，不要在业务逻辑里散写 `\x1b[...`

## 终端布局规格（精确值，各任务共用）

**展开态头部（`qrRows + 5` 行，本机当前为 23 行）** —— 需 `rows >= qrRows + 5 + 5`（5 行固定开销 + 5 行最小日志区）：

```
1  ────────────────────────────────  ← 满宽 '─'，重复 columns 次
2  mPaaS JSAPI 代理服务器 · 端口 7521
3  ws://192.168.1.5:7521
4..(qrRows+3)  [二维码 qrRows 行，来自 qrcode-terminal 的实际输出]
qrRows+4       真机 1 · 模拟器 1 · 端口 7521 · 按 q 收起二维码
qrRows+5       ────────────────────────────────
```

上面的 23 行 / 28 行阈值只是**本机当前网络环境下的一个实例**（`qrRows = 18`）。实现一律从 `qrRowCount(qrText)` 推导，不得写死。

**收起态头部（4 行）**：

```
1  ────────────────────────────────
2  mPaaS JSAPI 代理服务器 · 端口 7521
3  ws://192.168.1.5:7521
4  真机 1 · 模拟器 1 · 端口 7521 · 按 q 显示二维码
```

**日志区**：`rows - headerHeight` 行，至少 1 行。

**关键实测数据**（spec §3）：`qrcode-terminal` 在 `{ small: true }` 下、当前 60 字符载荷输出 **18 行 × 35 列**，且为**纯文本块字符、不含任何 ANSI 转义**。行数随载荷变化：32 字符→14 行、60 字符→18 行、106 字符→20 行。

## Review Focus

以下是 spec 隐含但没有任何自动化测试覆盖、且最可能让使用者踩坑的输入类别。每条都在其归属任务的步骤里有对应验证：

1. **未捕获异常 / SIGTERM 后终端被留在 alt screen + raw mode** —— 使用者敲的命令看起来卡死、回显消失，需要 `reset` 才能恢复。这是此类改动最典型的翻车方式
2. **stdout 非 TTY 时被 ANSI 序列污染** —— `npm start > log.txt` 或 CI 场景下日志文件被转义序列塞满
3. **stdin 非 TTY 却调用 `setRawMode`** —— `npm start < /dev/null` 会直接抛 `ERR_TTY_INIT_FAILED` 崩溃
4. **终端尺寸极小或 `columns`/`rows` 为 `undefined`** —— 分屏、`stty` 改尺寸、某些 IDE 终端下会出现，布局计算不能算出负数行数或崩溃
5. **中文 + emoji 超宽日志行的折行** —— 日志含 `ℹ️✅❌⚠️` 与中文，超宽时必须原样输出由终端折行，不能截断也不能破坏滚动区

---

### Task 1: 日志格式化与出口解耦

把日志输出收敛为「格式化」+「可替换 sink」两步，为 TUI 接管输出铺路。**本任务完成后行为必须与改造前完全一致。**

**Files:**
- Modify: `src/server/utils.ts`（全文 34 行）

**Interfaces:**
- Consumes: 无
- Produces:
  - `type LogType = 'info' | 'success' | 'error' | 'warn'`
  - `type LogSink = (line: string) => void`
  - `Utils.formatLogLine(message: string, type?: LogType): string` —— 返回 `[HH:MM:SS] <图标> <message>`
  - `Utils.setLogSink(sink: LogSink | null): void` —— `null` 表示恢复默认 `console.log`
  - `Utils.log(message: string, type?: LogType): void` —— **签名不变**，5 个既有调用点不受影响

- [ ] **Step 1: 用 tsx 断言确认改造前的基准行为**

```bash
npx tsx -e "
import { Utils } from './src/server/utils';
console.log(JSON.stringify(Utils.log('测试消息', 'warn')));
"
```

Expected: 打印一行形如 `[11:30:00] ⚠️ 测试消息`（时间随实际）。记下这个格式，它就是 `formatLogLine` 必须复现的基准。

- [ ] **Step 2: 实现 `formatLogLine` / `setLogSink`，`log` 改为委托**

抽出类常量 `ICONS: Record<LogType, string>`（值：`info: 'ℹ️'`, `success: '✅'`, `error: '❌'`, `warn: '⚠️'`），`formatLogLine` 复刻 Step 1 的基准格式。`log` 内部：有 sink 就调 sink，否则 `console.log`。

`Utils.getLocalIP()` 与 `Utils.formatServerUrl()` **保持原样不动**。

- [ ] **Step 3: 断言 sink 生效且能还原**

```bash
npx tsx -e "
import { Utils } from './src/server/utils';
const got: string[] = [];
Utils.setLogSink(l => got.push(l));
Utils.log('走 sink', 'success');
Utils.setLogSink(null);
Utils.log('走 console', 'info');
if (got.length !== 1) throw new Error('sink 应只收到 1 行，实际 ' + got.length);
if (!got[0].includes('✅ 走 sink')) throw new Error('sink 内容不对: ' + got[0]);
if (!/^\[\d{2}:\d{2}:\d{2}\] /.test(got[0])) throw new Error('缺少时间戳前缀: ' + got[0]);
console.log('OK  sink 收到:', got[0]);
"
```

Expected: 先打印 `OK  sink 收到: [..] ✅ 走 sink`，随后打印 `[..] ℹ️ 走 console`（走 console，未被 sink 捕获）。

- [ ] **Step 4: 确认真实启动的输出与改造前一致**

```bash
npm run type-check && timeout 3 npm start; true
```

Expected: 输出与改造前逐字一致——`代理服务器启动成功` / `监听端口: 7521` / 原框线 + 二维码，行首均有 `[时间] 图标 ` 前缀。

- [ ] **Step 5: 提交**

```bash
git add src/server/utils.ts
git commit -m "refactor(server): 日志输出抽出格式化与可替换 sink"
```

---

### Task 2: TUI 纯计算层

`tui.ts` 中所有**不碰终端 I/O** 的纯函数。单独成任务是因为这部分可以用 tsx 直接断言，而 Task 3 的终端部分只能手工验证。

**Files:**
- Create: `src/server/tui.ts`
- Test: 无测试文件，用 `npx tsx -e` 临时断言

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface ProxyStatus { deviceCount: number; simulatorCount: number; port: number }`
  - `interface HeaderInfo { port: number; serverUrl: string; status: string; qrLines: string[] }`
  - `const MIN_LOG_ROWS = 5`
  - `function qrRowCount(qrText: string): number` —— 从 `qrcode-terminal` 的实际输出数出行数
  - `function headerHeight(qrRows: number, qrVisible: boolean): number` —— 展开 `qrRows + 5`、收起 4
  - `function shouldExpandByDefault(rows: number, qrRows: number): boolean` —— `rows >= headerHeight(qrRows, true) + MIN_LOG_ROWS`
  - `function buildStatusLine(s: ProxyStatus): string` —— 如 `真机 1 · 模拟器 1 · 端口 7521`
  - `function buildHeader(info: HeaderInfo, columns: number): string[]` —— 返回逐行头部，**不含尾部换行**

**二维码行数必须实测，不得写成常量。** 载荷为 `xlmpaas://<appId>?url=ws%3A%2F%2F<ip>%3A<port>`，其中本机 IP 长度可变（`192.168.1.5` 与 `192.168.100.100` 会跨过二维码版本边界），实测行数在 14~20 之间浮动。行数一旦算错，滚动区起始行就错位、整个布局塌掉——所以 `qrRowCount` 必须从真实生成的文本得出，`headerHeight` / `shouldExpandByDefault` 都从它推导。

- [ ] **Step 1: 写断言并确认其失败**

```bash
npx tsx -e "
import { headerHeight, shouldExpandByDefault, buildStatusLine } from './src/server/tui';
console.log(headerHeight(18, true));
"
```

Expected: FAIL，报模块或导出不存在。

- [ ] **Step 2: 实现上述导出**

`qrRowCount` 的实现：按 `\n` 切分后**丢弃末尾空段**（`qrcode-terminal` 的输出以换行结尾）并数出非空行数。必须直接消费真实文本，不要在此处做任何长度→行数的估算。

`headerHeight`：`qrVisible ? qrRows + 5 : 4`（展开态顺序为 分隔线 / 标题 / URL / 二维码 / 状态 / 分隔线）。传入 `qrVisible=false` 时忽略 `qrRows`。

`buildHeader` 的列 1 与末行用 `'─'.repeat(columns)` 生成满宽分隔线。收起态无末行分隔线。

`buildStatusLine` 用 `·` 连接三段：`真机 ${deviceCount} · 模拟器 ${simulatorCount} · 端口 ${port}`；当 `deviceCount === 0` 时首段改为 `等待真机连接`。

**不要**在头部里画竖线边框，**不要**截断超宽内容——spec §3 已确认这二者都需要显示宽度计算，而绕开它们正是本设计的取舍。

- [ ] **Step 3: 断言布局边界（含 Review Focus #4）**

```bash
npx tsx -e "
import { qrRowCount, headerHeight, shouldExpandByDefault, buildHeader, buildStatusLine } from './src/server/tui';

const eq = (a:any, b:any, m:string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m + ': ' + JSON.stringify(a) + ' != ' + JSON.stringify(b)); };

// qrRowCount 必须实测而非估算：末尾换行不得被算成一行
eq(qrRowCount('a\nb\nc\n'), 3, 'qrRowCount 须丢弃末尾空段');
eq(qrRowCount('a\nb\nc'), 3, 'qrRowCount 无尾换行同样为 3');
eq(qrRowCount(''), 0, '空文本为 0 行');

// 行数随载荷浮动（实测 32→14、60→18、106→20），布局必须跟着走
eq(headerHeight(18, true), 23, '18 行二维码的展开态头部');
eq(headerHeight(14, true), 19, '14 行二维码的展开态头部（更短的 IP）');
eq(headerHeight(20, true), 25, '20 行二维码的展开态头部（更长的 IP）');
eq(headerHeight(18, false), 4, '收起态头部长与二维码无关');
eq(headerHeight(20, false), 4, '收起态头部长与二维码无关');

// 阈值随二维码行数浮动：18 行→28，20 行→30
eq(shouldExpandByDefault(28, 18), true, '28 行 / 18 行码 应展开');
eq(shouldExpandByDefault(27, 18), false, '27 行 / 18 行码 应收起');
eq(shouldExpandByDefault(29, 20), false, '29 行 / 20 行码 应收起（日志区不足 5 行）');
eq(shouldExpandByDefault(30, 20), true, '30 行 / 20 行码 应展开');

// 极小终端不能算出负的日志区
eq(shouldExpandByDefault(5, 18), false, '5 行必须收起');
eq(shouldExpandByDefault(0, 18), false, '0 行必须收起');
eq(shouldExpandByDefault(NaN as any, 18), false, 'NaN 必须收起');

// 收起态头部 4 行，且首行满宽
const collapsed = buildHeader({ port: 7521, serverUrl: 'ws://1.2.3.4:7521', status: '等待真机连接 · 模拟器 0 · 端口 7521', qrLines: [] }, 80);
eq(collapsed.length, 4, '收起态头部行数');
eq(collapsed[0].length, 80, '分隔线满宽');
if (!collapsed[0].startsWith('────')) throw new Error('首行应为分隔线');
if (collapsed.some(l => l.includes('\x1b'))) throw new Error('头部纯函数不得产生转义序列');

// 展开态二维码各行原样嵌入，总长随 qrRows 走
const qr18 = Array.from({length: 18}, () => '█'.repeat(35));
const expanded18 = buildHeader({ port: 7521, serverUrl: 'ws://1.2.3.4:7521', status: '真机 1 · 模拟器 1 · 端口 7521', qrLines: qr18 }, 80);
eq(expanded18.length, 23, '展开态头部行数');
eq(expanded18.slice(3, 21), qr18, '二维码各行须原样嵌入、不被截断');

const qr20 = Array.from({length: 20}, () => '█'.repeat(39));
const expanded20 = buildHeader({ port: 7521, serverUrl: 'ws://192.168.100.100:7521', status: '真机 1 · 模拟器 1 · 端口 7521', qrLines: qr20 }, 80);
eq(expanded20.length, 25, '20 行二维码时头部总长');
eq(expanded20.slice(3, 23), qr20, '长二维码同样原样嵌入');

// 状态行文案
eq(buildStatusLine({ deviceCount: 1, simulatorCount: 1, port: 7521 }), '真机 1 · 模拟器 1 · 端口 7521', '常规状态行');
eq(buildStatusLine({ deviceCount: 0, simulatorCount: 0, port: 7521 }), '等待真机连接 · 模拟器 0 · 端口 7521', '无真机状态行');

console.log('OK  Task 2 全部断言通过');
"
```

Expected: `OK  Task 2 全部断言通过`

- [ ] **Step 3b: 用真实二维码文本核对实测行数**

上面用的是构造文本。再用真实载荷跑一次，确认 `qrRowCount` 与 `qrcode-terminal` 的实际输出对得上：

```bash
npx tsx -e "
import { qrRowCount } from './src/server/tui';
import QRCode from 'qrcode-terminal';
import { Utils } from './src/server/utils';
import config from './src/server/config';

const url = Utils.formatServerUrl(Utils.getLocalIP(), 7521, '');
const data = 'xlmpaas://' + config.appId + '?url=' + encodeURIComponent(url);
QRCode.generate(data, { small: true }, (qr) => {
  const n = qrRowCount(qr);
  console.log('本机载荷:', data);
  console.log('qrRowCount =', n);
  if (n < 14 || n > 24) throw new Error('行数超出预期区间，布局阈值需重新评估: ' + n);
  console.log('OK  实测行数在预期区间内');
});
"
```

Expected: 打印本机真实载荷与行数（当前网络环境下应为 18 左右），并输出 `OK  实测行数在预期区间内`。

- [ ] **Step 4: 类型检查**

Run: `npm run type-check`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/server/tui.ts
git commit -m "feat(server): 新增 TUI 布局与头部拼装纯函数"
```

---

### Task 3: TUI 终端生命周期

`tui.ts` 的终端 I/O 部分：进入/退出 alt screen、滚动区、日志写入、状态重绘、`q` 切换、resize、raw mode。

**Files:**
- Modify: `src/server/tui.ts`（追加到 Task 2 之后）

**Interfaces:**
- Consumes: Task 2 的 `qrRowCount` / `headerHeight` / `shouldExpandByDefault` / `buildHeader` / `buildStatusLine` / `ProxyStatus`
- Produces:
  - `interface TuiOptions { port: number; serverUrl: string; qrText: string; onQuit: () => void }` —— `qrText` 为 `qrcode-terminal` 的完整输出（含换行）；`qrRows` 由 `Tui` 内部用 `qrRowCount(qrText)` 求出，**不通过参数传入**，避免调用方算出不同的值
  - `class Tui`：
    - `static isSupported(): boolean` —— `!!process.stdout.isTTY && (process.stdout.columns ?? 0) > 0 && (process.stdout.rows ?? 0) > 0`
    - `constructor(opts: TuiOptions)`
    - `start(): void`
    - `appendLog(line: string): void`
    - `setStatus(status: ProxyStatus): void`
    - `toggleQr(): void`
    - `stop(): void` —— **必须幂等**，重复调用安全

**失败模式必须先于成功路径处理：** `stop()` 是唯一的恢复路径，它被从 4 个地方调用（正常退出、SIGINT、SIGTERM、`uncaughtException`），漏掉任何一条都会把使用者的终端留在 alt screen + raw mode 里。

- [ ] **Step 1: 实现转义常量与 `start` / `stop`**

转义常量集中在文件顶部：`ALT_ON`/`ALT_OFF`/`CLEAR`/`HOME`/`SCROLL_REGION(top, bottom)`/`SCROLL_RESET`/`CURSOR(row, col)`/`CLEAR_LINE`/`SAVE_CURSOR`/`RESTORE_CURSOR`。

`start()` 顺序：写 `ALT_ON` + `CLEAR` + `HOME` → 画头部（Task 2 的 `buildHeader`）→ 写 `SCROLL_REGION(headerHeight + 1, rows)` → 光标移到 `(headerHeight + 1, 1)` → 绑定 `process.stdout.on('resize', ...)` → **仅当 `process.stdin.isTTY` 时** 才 `process.stdin.setRawMode(true)` + `resume()` + 绑 `data`（见 Review Focus #3）。

`stop()` 顺序：重置 `SCROLL_RESET` → 写 `ALT_OFF` → 解绑 resize/data 监听 → **仅当之前真的进过 raw mode 时** 才 `setRawMode(false)`；用 `private stopped = false` 保证幂等。

- [ ] **Step 2: 实现 `appendLog` / `setStatus` / `toggleQr`**

`appendLog`：推入 200 行环形缓冲，然后 `process.stdout.write(line + '\n')` —— **不截断、不折行处理**，超宽交给终端自动折行（Review Focus #5）。

`setStatus`：把新的 `ProxyStatus` 与上一次比对，**变化时**才用 `SAVE_CURSOR` → `CURSOR(状态行号, 1)` + `CLEAR_LINE` → 写状态文本 → `RESTORE_CURSOR` 重绘那一行。状态行位于滚动区**上方**，移动过去不会触发滚动。

`toggleQr` 与 resize **共用同一条重绘路径** `redraw()`：写 `CLEAR` + `HOME` → 按新高度画头部 → 重设滚动区 → 用环形缓冲里最后 `logHeight` 行回填 → 光标归位到日志区末尾。

- [ ] **Step 3: 断言 `stop()` 幂等（含 Review Focus #1 的代码侧保证）**

```bash
npx tsx -e "
import { Tui } from './src/server/tui';
// 非 TTY 环境下 isSupported 必须为 false，且 stop() 重复调用不得抛错
console.log('isSupported(非 TTY):', Tui.isSupported());
if (Tui.isSupported() !== false) throw new Error('管道环境下 isSupported 应为 false');
const t = new Tui({ port: 7521, serverUrl: 'ws://1.2.3.4:7521', qrText: '', onQuit: () => {} });
t.stop(); t.stop(); t.stop();
console.log('OK  stop() 三次调用未抛错');
" | cat
```

Expected: `isSupported(非 TTY): false` 与 `OK  stop() 三次调用未抛错`。**用 `| cat` 确保 stdout 非 TTY**——这同时覆盖了 Review Focus #2。

- [ ] **Step 4: 手工验证布局、切换与恢复（覆盖 Review Focus #1 / #4 / #5）**

```bash
npm start
```

逐项确认：
- 头部固定在顶部，二维码完整可见（若终端 ≥ 28 行）或收起并提示 `按 q 显示二维码`
- 在模拟器项目中触发若干次 `my.call`，日志在下方滚动，**头部不移位**
- 按 `q` → 二维码展开/收起，且**回填的历史日志仍在**
- 拖动窗口改变尺寸 → 布局重绘正确，无残影、无错行
- 中文与 `ℹ️✅❌⚠️` 超宽日志行折行后，头部与滚动区仍正常
- 把窗口缩到很小（如 10 行）→ 不崩溃，日志区至少 1 行

- [ ] **Step 5: 手工验证终端恢复（Review Focus #1）**

```bash
npm start
# Ctrl+C 退出
```

确认：终端回到正常缓冲区、键盘回显恢复正常、主屏留有 URL 与二维码、`stty -a` 无异常。随后再单独跑一次并 `kill -TERM <pid>`，同样确认已恢复。

- [ ] **Step 6: 提交**

```bash
git add src/server/tui.ts
git commit -m "feat(server): 实现 TUI 终端生命周期与渲染"
```

---

### Task 4: 接入 ProxyServer 与 CLI 入口

把 TUI 接到真实服务上：头部数据、状态轮询、模式判定、信号处理。

**Files:**
- Modify: `src/server/server.ts`（`displayConnectionInfo()` 处，第 87-108 行）
- Modify: `src/server/index.ts`（全文 24 行）

**Interfaces:**
- Consumes: `Tui`（Task 3）、`Utils.setLogSink` / `Utils.formatLogLine`（Task 1）
- Produces:
  - `ProxyServer` 新增 `getStatus(): ProxyStatus` —— 供状态轮询调用
  - `ProxyServer` 的 `displayConnectionInfo()` 拆为 `renderTuiHeader(): void` 与 `printPlainHeader(): void`

**状态数据用 `deviceManager.devicesMap`，不是 `getAllDevices()`。** spec §5 写的是后者，但 `getAllDevices()`（`device-manager.ts:97`）只返回 `{deviceId, hasMiniapp, lastHeartbeat}`，**拿不到模拟器连接状态**；而 `devicesMap` 是已有的公开 getter（`device-manager.ts:106`），能同时得到 `device.ws`（真机）与 `device.simulatorWS`（模拟器）。两者都是既有公开 API，故文件清单不变、仍需满足「改动限于 4 个文件」。

- [ ] **Step 1: 在 `ProxyServer` 中加 `getStatus()`**

从 `this.deviceManager.devicesMap` 遍历：`deviceCount` 统计 `!!device.ws`，`simulatorCount` 统计 `!!device.simulatorWS`，`port` 取 `this.config.port`。

- [ ] **Step 2: 拆分头部渲染并接线 TUI**

`printPlainHeader()` 保留现有框线与二维码输出**逐字不变**（含 `config.appId`，见 spec §8 的既有瑕疵——本次不修，但两条路径必须用**同一个** appId 来源，否则会生成两个不同的二维码）。

`renderTuiHeader()` 取 `Utils.getLocalIP()` + `Utils.formatServerUrl()` 与 `qrcode-terminal` 的字符串输出，交给 `Tui`。

**取二维码字符串要用回调形式**：`QRCode.generate(data, { small: true }, (qr) => ...)` —— 当前代码用的是直接打印形式（`server.ts:107`），必须改成回调，否则二维码会被写到滚动区而非头部。

- [ ] **Step 3: 在 `index.ts` 中做模式判定与生命周期接线**

```
支持 TUI  ←  Tui.isSupported() && !args['no-tui']
            →  const tui = new Tui({
                 port: finalConfig.port,
                 serverUrl: <与 printPlainHeader 同一个来源, 格式 ws://<ip>:<port>>,
                 qrText:   <qrcode-terminal 回调形式拿到的完整输出>,
                 onQuit:   () => { proxyServer.stop(); process.exit(0); },
               })
            →  Utils.setLogSink(line => tui.appendLog(line))
            →  tui.start()
            →  否则 Utils.setLogSink(null)，走 printPlainHeader()，行为与改造前一致
```

> **与 spec 的接口命名差异（有意为之）：** spec §5 写的是 `enter()` / `exit()` / `renderHeader()`。本计划改用 `start()` / `stop()`，并把 `renderHeader` 收进 `start` 与内部 `redraw`。原因是 `exit()` 与 `process.exit` 的语境容易混淆，且 `stop()` 需承担「四条退出路径共用的幂等恢复点」这一更强语义。语义与职责未变。

绑定退出路径（**四条都要**）：`process.on('exit')` 中调用 `tui.stop()`；`SIGINT` / `SIGTERM` 调用关闭流程；`uncaughtException` 先 `tui.stop()` 再打印错误并退出。`--no-tui` 与 `--p/--port` 一样用已引入的 `minimist` 解析。

状态轮询：`setInterval(1000)` 调 `server.getStatus()` 后 `tui.setStatus(...)`（`setStatus` 内部已做变化比对，无需在此判重）；退出时 `clearInterval`。

- [ ] **Step 4: 验证非 TTY 降级（Review Focus #2）**

```bash
npm start > /tmp/jsapi-plain.log 2>&1 &
SRV=$!
sleep 2
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
echo "含转义序列的行数: $(grep -c $'\x1b' /tmp/jsapi-plain.log || true)"
head -20 /tmp/jsapi-plain.log
```

Expected: **转义序列个数为 0**，且内容与改造前的纯日志 + 框线二维码逐字一致。

> 注意：把 stdout 重定向到文件本身就使 `process.stdout.isTTY` 为假，因此这条命令直接覆盖了非 TTY 分支，无需真的接一个 `| cat`。

- [ ] **Step 5: 验证 stdin 非 TTY 不崩溃（Review Focus #3）**

```bash
timeout 3 npm start < /dev/null; echo "退出码: $?"
```

Expected: 正常运行满 3 秒后被 `timeout` 终止，**不出现** `ERR_TTY_INIT_FAILED`。

- [ ] **Step 6: 端到端手工验证**

在真机小程序与模拟器项目中各连一次，确认：头部二维码可扫且地址正确、状态行在连接/断开时于 1 秒内反映为 `真机 1 · 模拟器 1`、日志滚动正常、Ctrl+C 后终端与主屏均正常。

- [ ] **Step 7: 提交**

```bash
git add src/server/server.ts src/server/index.ts
git commit -m "feat(server): 接入 TUI 头部渲染与状态轮询"
```

---

### Task 5: 日志落盘 `--log-file`

兑现 spec §5 的 `--log-file`，解决「会话日志没有留痕」——这是让「日志滚走」真正得到解决的另一半。

**Files:**
- Modify: `src/server/index.ts`（仅此一个文件）

**Interfaces:**
- Consumes: `Utils.setLogSink` / `Utils.formatLogLine`（Task 1）、`Tui.appendLog`（Task 3）
- Produces: CLI 参数 `--log-file <path>`

- [ ] **Step 1: 实现文件 sink**

`--log-file` 给出路径时，用**一次性创建的 `fs.createWriteStream`**（`flags: 'a'`）追加写入，而非每行 `appendFileSync`。sink 组合为：每一行同时 `tui.appendLog(line)`（TUI 开启时）与 `stream.write(line + '\n')`。默认不开启。退出时 `stream.end()`。

日志行必须**复用 `Utils.formatLogLine`**，使文件内容与终端显示逐字一致（沿用 spec §5 的约定）。

- [ ] **Step 2: 验证落盘内容与终端一致**

```bash
npm start -- --log-file /tmp/jsapi.log < /dev/null > /dev/null 2>&1 &
LOG_PID=$!
sleep 1.5
kill $LOG_PID 2>/dev/null; wait $LOG_PID 2>/dev/null
sleep 0.3
cat /tmp/jsapi.log
```

Expected: 文件内含 `代理服务器启动成功`、`监听端口: 7521` 等行，每行格式为 `[HH:MM:SS] <图标> <消息>`，与终端显示一致，且**不含任何转义序列**。

- [ ] **Step 3: 验证 TUI 开启时终端与文件内容一致**

```bash
npm start -- --log-file /tmp/jsapi-tui.log
```

触发几次 `my.call` 后 Ctrl+C。对比终端可见日志与 `/tmp/jsapi-tui.log`，Expected: 同一批日志行内容一致；差异只允许是终端额外渲染的头部（分隔线、二维码、状态行），这些**不应**出现在文件里。

- [ ] **Step 4: 提交**

```bash
git add src/server/index.ts
git commit -m "feat(server): 支持 --log-file 将日志落盘"
```

---

### Task 6: 全量验证与产物核对

收口任务：确认改造未破坏既有契约与产物形态。

**Files:** 无（只做验证，不改代码）

- [ ] **Step 1: 类型检查与构建**

```bash
npm run type-check && npm run build
```

Expected: 均无错误。

- [ ] **Step 2: 核对 `dist/server.js` 仍是零依赖单文件**

```bash
ls -lh dist/server.js
echo "--- 产物中出现的裸 require（应为空或仅 Node 内置模块）---"
node -e "
const s = require('fs').readFileSync('dist/server.js', 'utf8');
const m = [...s.matchAll(/require\([\"']([^\"']+)[\"']\)/g)].map(x => x[1]);
const uniq = [...new Set(m)].sort();
console.log(uniq.length ? uniq.join(', ') : '(无)');
const bad = uniq.filter(n => ['ws','qrcode-terminal','minimist'].includes(n));
if (bad.length) { console.error('以下依赖未被打入产物: ' + bad.join(', ')); process.exit(1); }
console.log('OK  第三方依赖均已打入，无外部 require');
"
```

Expected: 体积与改造前（77KB）同一量级；第三方依赖未出现在 `require` 列表中，输出 `OK  第三方依赖均已打入，无外部 require`。

> 实测当前产物列出的 `require` 为：`buffer, bufferutil, crypto, events, http, https, net, os, stream, tls, url, utf-8-validate, util, zlib`。其中除 Node 内置模块外，`bufferutil` 与 `utf-8-validate` 是 `ws` 的**可选原生加速模块**，`rollup.config.mjs` 有意将其保持 external（打入会携带 `.node` 二进制导致跨环境损坏），**是预期内的**，不算失败。

> 这里必须用 `node -e` 逐条枚举，不能只用 `grep -c`——`dist/server.js` 是压缩后的单行式产物，`grep -c` 统计的是匹配**行数**而非出现次数，会给出误导性结果。

- [ ] **Step 3: 跑一遍 Review Focus 全清单**

以下每条都要实际执行并记录观察结果，**不得凭推断填写**：

| # | 场景 | 命令 |
|---|---|---|
| 1 | 终端恢复 | `npm start` → Ctrl+C；`npm start` → `kill -TERM <pid>`；`npm start` 后触发一次未捕获异常 |
| 2 | 非 TTY 不被污染 | `npm start > /tmp/x.log 2>&1 &` → `sleep 2` → 杀进程，再 `grep -c $'\x1b' /tmp/x.log`，结果应为 0 |
| 3 | stdin 非 TTY | `timeout 3 npm start < /dev/null`，不得出现 `ERR_TTY_INIT_FAILED` |
| 4 | 极小/异常尺寸 | 窗口缩到 10 行；`stty rows 5 cols 40` 后再启动 |
| 5 | 超宽中文/emoji 行 | 触发一条超宽调用日志，确认折行后头部不移位 |

> `timeout` 来自 GNU coreutils，macOS 默认没有，需 `brew install coreutils`（本机已装于 `/opt/homebrew/bin/timeout`）。若目标机器没有，改用 `npm start & sleep 3; kill $!` 等价写法。

- [ ] **Step 4: 确认范围未被突破**

```bash
git diff --stat main...HEAD
git status --short
```

Expected: 改动文件**只有** `src/server/tui.ts`、`src/server/utils.ts`、`src/server/server.ts`、`src/server/index.ts` 加两份 docs。若出现 `src/index.ts`、`device-manager.ts`、`message-router.ts`、`rollup.config.mjs` 或 `package.json` 的改动，说明范围被突破，需回退并说明理由。

> 注意：`package.json` 与 `src/index.ts` 在本次工作开始前**就已经是暂存状态**（属于别的工作），核对时须排除它们，不要误提交。

- [ ] **Step 5: 处理验证中发现的问题**

Step 3 的 5 项若全部通过，本任务**不需要提交**，到此结束。

若任一项未通过：修复对应代码 → **重跑该项验证**确认通过 → 重跑 `npm run type-check && npm run build` → 用一句具体描述该缺陷的消息提交，例如：

```bash
git add src/server/tui.ts
git commit -m "fix(server): 修正 SIGTERM 时未恢复终端 raw mode"
```

消息必须写明**具体是哪一条 Review Focus 被破坏**，不要用「修正验证中发现的问题」这类无法检索的措辞。
