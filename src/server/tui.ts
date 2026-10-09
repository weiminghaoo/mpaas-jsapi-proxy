// 服务端 TUI：二维码常驻固定头部，日志在下方滚动。
// 文件分两层：
//   1. 纯计算层——布局计算、头部拼装、状态行。不碰终端、不产生 ANSI 转义，
//      全部是可独立断言的纯函数，便于在无终端环境下验证。
//   2. 终端 I/O 层（文件末尾的 Tui 类）——把纯计算层的结果写成控制序列。
// 两层之间只通过纯函数返回值传递数据，控制序列不参与布局计算。

// ===== 控制序列常量（全文件唯一允许出现控制字符的地方，业务逻辑一律引用常量）=====
const ALT_ON = '\x1b[?1049h'; // 进入备用屏
const ALT_OFF = '\x1b[?1049l'; // 退出备用屏、回主屏
const CLEAR = '\x1b[2J'; // 清屏
const HOME = '\x1b[H'; // 光标归位到左上角
const SCROLL_RESET = '\x1b[r'; // 复位滚动区为整屏
const CLEAR_LINE = '\x1b[2K'; // 清空整行
const SAVE_CURSOR = '\x1b7'; // 保存光标位置
const RESTORE_CURSOR = '\x1b8'; // 恢复光标位置

// 设置滚动区上下界（均为 1 基、闭区间）
const SCROLL_REGION = (top: number, bottom: number): string => `\x1b[${top};${bottom}r`;

// 光标定位到第 row 行第 col 列（1 基）
const CURSOR = (row: number, col: number): string => `\x1b[${row};${col}H`;

// 按键：raw mode 下 Ctrl+C 不再产生 SIGINT，只能按字节自行识别
const KEY_CTRL_C = '\x03';
const KEY_TOGGLE_QR = 'q';

// ===== 纯计算层 =====

// 代理服务器状态：用于拼装状态行
export interface ProxyStatus {
  deviceCount: number; // 已连接真机数
  simulatorCount: number; // 已连接模拟器数
  port: number; // 监听端口
}

// 头部拼装所需的全部信息
export interface HeaderInfo {
  port: number; // 监听端口
  serverUrl: string; // 形如 ws://<ip>:<port>
  status: string; // 状态行文案（由 buildStatusLine 生成）
  qrLines: string[]; // 二维码逐行文本；为空表示收起态
}

// 日志区最小保留行数：终端扣除头部后至少留这么多行才默认展开二维码
export const MIN_LOG_ROWS = 5;

// 展开态头部在二维码之外固定占用的行数：分隔线 / 标题 / URL / 状态 / 分隔线
const EXPANDED_OVERHEAD = 5;
// 收起态头部的固定行数：分隔线 / 标题 / URL / 状态（无末行分隔线）
const COLLAPSED_HEIGHT = 4;

// 展开 / 收起态状态行末尾的操作提示
const HINT_EXPANDED = ' · 按 q 收起二维码';
const HINT_COLLAPSED = ' · 按 q 显示二维码';

// 从 qrcode-terminal 的实际输出数出行数。
// 输出以换行结尾，split 后末尾会产生空段，需丢弃只数非空行。
// 绝不做长度→行数的估算：载荷随本机 IP 长度变化会跨二维码版本边界。
export function qrRowCount(qrText: string): number {
  return qrText.split('\n').filter((line) => line.length > 0).length;
}

// 头部总行数：展开态为二维码行数加固定开销，收起态为固定 4 行（忽略 qrRows）
export function headerHeight(qrRows: number, qrVisible: boolean): number {
  return qrVisible ? qrRows + EXPANDED_OVERHEAD : COLLAPSED_HEIGHT;
}

// 是否默认展开二维码：展开后剩余高度仍能容纳最小日志区
export function shouldExpandByDefault(rows: number, qrRows: number): boolean {
  return rows >= headerHeight(qrRows, true) + MIN_LOG_ROWS;
}

// 拼装状态行文案：`真机 N · 模拟器 N · 端口 N`，无真机时首段改为等待提示
export function buildStatusLine(s: ProxyStatus): string {
  const devicePart = s.deviceCount === 0 ? '等待真机连接' : `真机 ${s.deviceCount}`;
  return `${devicePart} · 模拟器 ${s.simulatorCount} · 端口 ${s.port}`;
}

// 拼装逐行头部（不含尾部换行）。
// 展开态（qrLines 非空）：分隔线 / 标题 / URL / 二维码若干行 / 状态 / 分隔线；
// 收起态：分隔线 / 标题 / URL / 状态。
// 刻意不画竖线边框、不截断超宽内容——二者都需要显示宽度计算，本设计绕开。
export function buildHeader(info: HeaderInfo, columns: number): string[] {
  const qrVisible = info.qrLines.length > 0;
  const separator = '─'.repeat(columns);
  const lines: string[] = [separator];
  lines.push(`mPaaS JSAPI 代理服务器 · 端口 ${info.port}`);
  lines.push(info.serverUrl);
  if (qrVisible) {
    lines.push(...info.qrLines);
  }
  lines.push(info.status + (qrVisible ? HINT_EXPANDED : HINT_COLLAPSED));
  if (qrVisible) {
    lines.push(separator);
  }
  return lines;
}

// ===== 终端 I/O 层 =====

// Tui 所需的全部输入
export interface TuiOptions {
  port: number; // 监听端口
  serverUrl: string; // 形如 ws://<ip>:<port>
  qrText: string; // qrcode-terminal 的完整输出（含换行）
  onQuit: () => void; // 退出请求回调（raw mode 下按 Ctrl+C 触发）
}

// 重绘回填用的日志环形缓冲上限，与可见高度无关：
// 终端由矮拉高时新露出的行要从历史里补，容量按「够覆盖常见 resize」取值
const LOG_BUFFER_LIMIT = 200;

export class Tui {
  private readonly opts: TuiOptions;
  // 二维码行数由真实文本数出，不接受外部传入，避免调用方算出不同的值
  private readonly qrRows: number;
  // 二维码逐行文本，原样交给 buildHeader（丢弃末尾换行产生的空段）
  private readonly qrLines: string[];
  private qrVisible: boolean;
  private status: ProxyStatus;
  private readonly logBuffer: string[] = [];
  private started = false;
  private stopped = false;
  private rawMode = false;

  constructor(opts: TuiOptions) {
    this.opts = opts;
    this.qrRows = qrRowCount(opts.qrText);
    this.qrLines = opts.qrText.split('\n').filter((line) => line.length > 0);
    // 没有二维码文本时不得置为展开态：buildHeader 以 qrLines 是否为空判定展开，
    // 否则头部会收起却提示「按 q 收起二维码」
    this.qrVisible = this.qrRows > 0 && shouldExpandByDefault(this.rows(), this.qrRows);
    this.status = { deviceCount: 0, simulatorCount: 0, port: opts.port };
  }

  // 仅在具备尺寸的真终端上启用；非 TTY（重定向、CI）与尺寸未知的终端一律降级
  static isSupported(): boolean {
    return !!process.stdout.isTTY && (process.stdout.columns ?? 0) > 0 && (process.stdout.rows ?? 0) > 0;
  }

  // 进入备用屏、画头部、建立滚动区。尾部顺序不可换：
  // 滚动区一旦设上，头部就只能画在区域之外，所以头部必须先画完
  start(): void {
    // 不支持 TUI 的终端（非 TTY / 尺寸未知）一个字节都不能写：ANSI 会污染重定向输出
    if (!Tui.isSupported()) return;
    // 已经退出过的实例不得再进入——stop() 幂等，进去就再也出不来了
    if (this.stopped) return;
    this.started = true;

    process.stdout.write(ALT_ON + CLEAR + HOME);
    this.drawHeader();
    this.applyScrollRegion();

    process.stdout.on('resize', this.handleResize);

    // stdin 非 TTY 时 setRawMode 会抛 ERR_TTY_INIT_FAILED，必须先行判断
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      this.rawMode = true;
      process.stdin.resume();
      process.stdin.on('data', this.handleData);
    }
  }

  // 唯一的终端恢复路径：正常退出 / SIGINT / SIGTERM / uncaughtException 四条路径共用，必须幂等
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // 从未进入过 TUI（非 TTY 降级）时无事可恢复，也不得向主屏补印
    if (!this.started) return;

    // 先复位滚动区再切屏：反过来的话恢复后的主屏仍带着滚动区
    process.stdout.write(SCROLL_RESET + ALT_OFF);

    process.stdout.off('resize', this.handleResize);
    // 只有真的进过 raw mode 才敢调 setRawMode(false)，否则非 TTY 下会抛错
    if (this.rawMode) {
      process.stdin.off('data', this.handleData);
      process.stdin.setRawMode(false);
      this.rawMode = false;
    }

    this.printSummary();
  }

  // 日志直接写进滚动区、由终端自行滚动；不截断、不做显示宽度计算，超宽交给终端折行
  appendLog(line: string): void {
    this.logBuffer.push(line);
    if (this.logBuffer.length > LOG_BUFFER_LIMIT) {
      this.logBuffer.shift();
    }
    // 终端放不下合法滚动区时只进缓冲、不写屏幕：写任何一行都会滚动整屏、把头部顶走
    if (!this.canScroll()) return;
    process.stdout.write(line + '\n');
  }

  // 状态未变化时不重绘，变化时只重画状态行那一行
  setStatus(status: ProxyStatus): void {
    if (this.sameStatus(this.status, status)) return;
    this.status = status;

    const row = this.statusRow();
    // 状态行文本以 buildHeader 为唯一来源：q 提示只在它内部拼接，
    // 在这里自行拼装会让提示在第一次设备状态变化时静默消失
    const text = this.headerLines()[row - 1];
    // 状态行位于滚动区上方，移过去重画不会触发滚动
    process.stdout.write(SAVE_CURSOR + CURSOR(row, 1) + CLEAR_LINE + text + RESTORE_CURSOR);
  }

  // q 键：就地展开 / 收起二维码，历史日志经 redraw 回填
  toggleQr(): void {
    if (this.qrRows === 0) return;
    this.qrVisible = !this.qrVisible;
    this.redraw();
  }

  // 头部逐行写入，末尾不补换行：补了会在矮终端上把已画好的头部顶上去
  private drawHeader(): void {
    process.stdout.write(this.headerLines().join('\n'));
  }

  // q 切换与 resize 共用的重绘路径：整屏重画后回填最近日志
  private redraw(): void {
    process.stdout.write(CLEAR + HOME);
    this.drawHeader();
    // 没有合法滚动区时不回填：回填同样是写日志行，会把整屏滚动、头部顶走
    if (!this.applyScrollRegion()) return;

    // 回填最后「日志区高度」行；光标落在回填内容之后，后续日志从这里续写
    const history = this.logBuffer.slice(-this.logRows());
    if (history.length > 0) {
      process.stdout.write(history.join('\n') + '\n');
    }
  }

  // 备用屏的内容随退出一起消失，故退出后把地址与二维码补印回主屏，
  // 使用者因此仍能在 scrollback 里找到它们
  private printSummary(): void {
    process.stdout.write(this.opts.serverUrl + '\n');
    if (this.qrLines.length > 0) {
      process.stdout.write(this.qrLines.join('\n') + '\n');
    }
  }

  // 逐行头部；状态行文本由 buildStatusLine 生成，q 提示由 buildHeader 追加
  private headerLines(): string[] {
    const info: HeaderInfo = {
      port: this.opts.port,
      serverUrl: this.opts.serverUrl,
      status: buildStatusLine(this.status),
      qrLines: this.qrVisible ? this.qrLines : []
    };
    return buildHeader(info, this.columns());
  }

  // 头部行数：展开态为二维码行数加固定开销，收起态恒为 4
  private headRows(): number {
    return headerHeight(this.qrRows, this.qrVisible);
  }

  // 该尺寸下滚动区是否可表达：DECSTBM 要求 top < bottom，即头部下方至少要有 2 行。
  // 用「≥ 头部 + 2」而不是「≥ 头部 + 1」：top == bottom 的 DECSTBM 是非法序列，
  // 真实终端会忽略它并保留上一次的边距（或复位成整屏），后果比根本不设区域更糟——
  // 头部会被随后的日志顶走，而 statusRow() 仍按旧布局计算，越写越乱
  private canScroll(): boolean {
    return this.rows() >= this.headRows() + 2;
  }

  // 建立滚动区：合法则设上并把光标落到日志区首行；放不下合法区域时只复位区域。
  // 返回是否处于「有滚动区」状态——凡要写日志行的调用点必须据此判断
  private applyScrollRegion(): boolean {
    if (!this.canScroll()) {
      process.stdout.write(SCROLL_RESET);
      return false;
    }
    process.stdout.write(SCROLL_REGION(this.logTopRow(), this.rows()) + CURSOR(this.logTopRow(), 1));
    return true;
  }

  // 滚动区上界 = 头部行数 + 1（仅在 canScroll() 为真时有意义）
  private logTopRow(): number {
    return this.headRows() + 1;
  }

  // 滚动区行数（canScroll() 为真时恒 ≥ 2）
  private logRows(): number {
    return this.rows() - this.logTopRow() + 1;
  }

  // 状态行行号：展开态是头部倒数第二行（qrRows + 4），收起态是头部的最后一行（4）。
  // 两种情形不能用同一个 headerHeight ± k 表达——收起态的状态行不是倒数第二行
  private statusRow(): number {
    return this.qrVisible ? this.qrRows + 4 : 4;
  }

  private columns(): number {
    return process.stdout.columns ?? 0;
  }

  private rows(): number {
    return process.stdout.rows ?? 0;
  }

  private sameStatus(a: ProxyStatus, b: ProxyStatus): boolean {
    return a.deviceCount === b.deviceCount && a.simulatorCount === b.simulatorCount && a.port === b.port;
  }

  // 终端尺寸变化与 q 切换走同一条重绘路径
  private handleResize = (): void => {
    this.redraw();
  };

  // 按键：raw mode 下 Ctrl+C 收不到 SIGINT，只能按字节识别；q 切换二维码，其余忽略
  private handleData = (data: Buffer): void => {
    if (data.includes(KEY_CTRL_C)) {
      this.opts.onQuit();
      return;
    }
    if (data.includes(KEY_TOGGLE_QR)) {
      this.toggleQr();
    }
  };
}
