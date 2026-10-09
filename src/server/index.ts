import { ProxyServer } from './server';
import { Tui } from './tui';
import { Utils } from './utils';
import type { LogSink } from './utils';
import config from './config';
import minimist from 'minimist';
import fs from 'fs';

const args = minimist(process.argv.slice(2));

// 合并配置：命令行参数优先
const finalConfig = {
  ...config,
  ...(args.p !== undefined && { port: Number(args.p) }),
  ...(args.port !== undefined && { port: Number(args.port) }),
};

// 日志落盘路径：只有显式给出字符串路径才落盘，--log-file 不带值时 minimist 会解析成 true，视为未开启
const logFilePath =
  typeof args['log-file'] === 'string' && args['log-file'].length > 0 ? (args['log-file'] as string) : null;

const proxyServer = new ProxyServer(finalConfig);

// 头部与纯文本头部共用同一份连接信息，否则会生成两个不同的二维码
const { serverUrl, qrText } = proxyServer.buildConnectionInfo();

// minimist 的 `--no-x` 取反约定把 --no-tui 解析成 { tui: false }，不会留下 'no-tui' 键
const noTui = args.tui === false;

let tui: Tui | null = null;
let statusTimer: NodeJS.Timeout | null = null;

// 日志文件流：仅在给出 --log-file 时创建，一次性打开、追加写入（不逐行 open/close）。
// 未开启时保持 null，进程内不产生任何文件句柄
const logStream = logFilePath ? fs.createWriteStream(logFilePath, { flags: 'a' }) : null;

// 退出是否已在进行中：日志流使退出被推迟到 end() 的回调之后，期间可能再次收到信号，
// 用此标记保证收尾流程只跑一次
let exiting = false;

// 这四条必须注册在任何可能抛错的调用之前：tui.start() 会先进备用屏并开 raw mode，
// proxyServer.start() 也可能同步抛出（如 --port abc → ERR_SOCKET_BAD_PORT）。
// 注册晚了，抛错时没人恢复终端，用户就会被留在 alt screen + raw mode 里
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// 退出路径的最后一道兜底；exit 事件里只能跑同步代码，tui.stop() 是同步写，可以
process.on('exit', () => tui?.stop());

process.on('uncaughtException', (error) => {
  // 先恢复终端，崩溃信息才会落在主屏、而不是随备用屏一起消失
  tui?.stop();
  // 崩溃诊断必须走 sink：裸 console.error 会绕过 sink，开了 --log-file 时崩溃原因永远进不了文件。
  // 带上完整 stack（error.stack 首行已含 "Error: <message>"，故不再单独拼 message 以免重复前缀）
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  Utils.log(`未捕获异常: ${detail}`, 'error');
  // 复用 shutdown 的「等日志流 close 后退出」流程刷完缓冲，退出码仍为 1，1s 兜底防挂死
  shutdown(1);
});

// 终端不支持 TUI（stdout 非 TTY、尺寸未知）或显式 --no-tui 时，一律降级为纯文本头部。
// 日志出口按「TUI 开/关 × --log-file 开/关」四态组合：屏幕侧与文件侧互相独立，
// 屏幕侧保留 TUI 滚动区或默认 console.log，文件侧只是把同一行额外追加进文件
const writers: LogSink[] = [];

if (Tui.isSupported() && !noTui) {
  const instance = new Tui({
    port: finalConfig.port,
    serverUrl,
    qrText,
    // raw mode 下 Ctrl+C 不再产生 SIGINT，只能由 Tui 在按键层回调
    onQuit: () => shutdown(0),
  });
  // tui 必须先于 start() 赋值：start() 写完备用屏序列后仍可能抛错（如 setRawMode 抛
  // ERR_TTY_INIT_FAILED），此时只有 tui 非空，退出处理器才拿得到实例去恢复终端
  tui = instance;
  // 顺序不可换：先进备用屏画好头部，再挂日志 sink；
  // 反过来的话启动日志会落在主屏、把头部顶走
  instance.start();
  writers.push((line) => instance.appendLog(line));
  proxyServer.setTui(instance);
} else if (logStream) {
  // TUI 关闭但开了落盘：屏幕侧仍要走默认 console.log，否则日志只进文件、终端一片空白
  writers.push((line) => console.log(line));
}

// 文件侧：把 sink 收到的整行原样追加。该行已是 Utils.formatLogLine 的输出，
// 因此文件内容与终端逐字一致，且不含任何 ANSI 转义序列
if (logStream) {
  const stream = logStream;
  writers.push((line) => stream.write(line + '\n'));
}

// 屏幕侧与文件侧都关闭时（默认）不设 sink，走 Utils 内部的 console.log，与改造前一致
if (writers.length > 0) {
  Utils.setLogSink((line) => {
    for (const writer of writers) {
      writer(line);
    }
  });
} else {
  Utils.setLogSink(null);
}

// 启动 WebSocket 服务器（TUI 模式下头部已画过，server 内部不会重复打印）。
// 参数非法时 ws 会在构造函数内同步抛出（如 --port abc / 70000 → ERR_SOCKET_BAD_PORT），
// 而此时终端已进备用屏，必须先恢复再让异常继续上抛
try {
  proxyServer.start();
} catch (error) {
  tui?.stop();
  throw error;
}

// 状态轮询：setStatus 内部已做变化比对，此处无需判重
if (tui) {
  const activeTui = tui;
  activeTui.setStatus(proxyServer.getStatus());
  statusTimer = setInterval(() => activeTui.setStatus(proxyServer.getStatus()), 1000);
}

// 关闭流程：SIGINT / SIGTERM / uncaughtException 与 Tui 的 onQuit 共用。
// tui.stop() 自身幂等，但 proxyServer.stop() 不是——它清掉 heartbeatTimer 却把 wss 留在原处，
// 再次调用会重复 close 并再打一行「服务器已关闭」。退出被日志流的 flush 推迟后会留下
// 再次收到信号的窗口，重复进入一律由下面的 exiting 标记兜住，不依赖被调方幂等
function shutdown(code: number): void {
  if (exiting) return;
  exiting = true;

  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  // 关闭提示走 Utils.log 而非裸 console.log：TUI 模式下进滚动区、非 TUI 模式下照常上屏。
  // 必须在 tui.stop() 之前写，否则会落到已恢复的主屏上、把备用屏的内容顺序打乱
  Utils.log('正在关闭服务器...', 'info');
  // 先恢复终端再停服务器：「服务器已关闭」因此留在主屏的 scrollback 里，而不是随备用屏一起消失
  tui?.stop();
  proxyServer.stop();

  // 无日志流时与改造前逐字一致：立即退出
  if (!logStream) {
    process.exit(code);
    return;
  }

  // end() 的 flush 是异步的，紧接着 process.exit 会把最后一行（「服务器已关闭」）丢在缓冲里，
  // 使文件内容与终端不一致。等 'close'（fd 已关闭、数据已刷）再退出，
  // 并用兜底计时器防住流异常时 'close' 不来导致的挂起
  const stream = logStream;
  const forceExit = setTimeout(() => process.exit(code), 1000);
  stream.once('close', () => {
    clearTimeout(forceExit);
    process.exit(code);
  });
  stream.end();
}
