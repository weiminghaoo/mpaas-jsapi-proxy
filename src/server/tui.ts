// TUI 纯计算层：布局计算、头部拼装、状态行。
// 本文件不碰任何终端 I/O，也不产生 ANSI 转义序列——转义由上层 I/O 层负责。
// 这里的所有导出都是可独立断言的纯函数，便于在无终端环境下验证。

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
