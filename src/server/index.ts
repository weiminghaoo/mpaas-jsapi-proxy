import { ProxyServer } from './server';
import { Tui } from './tui';
import { Utils } from './utils';
import config from './config';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2));

// 合并配置：命令行参数优先
const finalConfig = {
  ...config,
  ...(args.p !== undefined && { port: Number(args.p) }),
  ...(args.port !== undefined && { port: Number(args.port) }),
};

const proxyServer = new ProxyServer(finalConfig);

// 头部与纯文本头部共用同一份连接信息，否则会生成两个不同的二维码
const { serverUrl, qrText } = proxyServer.buildConnectionInfo();

// minimist 的 `--no-x` 取反约定把 --no-tui 解析成 { tui: false }，不会留下 'no-tui' 键
const noTui = args.tui === false;

let tui: Tui | null = null;
let statusTimer: NodeJS.Timeout | null = null;

// 这四条必须注册在任何可能抛错的调用之前：tui.start() 会先进备用屏并开 raw mode，
// proxyServer.start() 也可能同步抛出（如 --port abc → ERR_SOCKET_BAD_PORT）。
// 注册晚了，抛错时没人恢复终端，用户就会被留在 alt screen + raw mode 里
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// 退出路径的最后一道兜底；exit 事件里只能跑同步代码，tui.stop() 是同步写，可以
process.on('exit', () => tui?.stop());

process.on('uncaughtException', (error) => {
  tui?.stop();
  console.error('未捕获异常:', error);
  process.exit(1);
});

// 终端不支持 TUI（stdout 非 TTY、尺寸未知）或显式 --no-tui 时，一律降级为纯文本头部
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
  Utils.setLogSink((line) => instance.appendLog(line));
  proxyServer.setTui(instance);
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

// 关闭流程：SIGINT / SIGTERM 与 Tui 的 onQuit 共用。
// tui.stop() 与 server.stop() 均幂等，多条路径重复进入无副作用
function shutdown(code: number): void {
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
  process.exit(code);
}
