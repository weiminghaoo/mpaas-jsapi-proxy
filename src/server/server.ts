import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode-terminal';
import { DeviceManager } from './device-manager';
import { MessageRouter } from './message-router';
import { Utils } from './utils';
import type { IncomingMessage } from 'http';
import config from './config';
import type { Tui, ProxyStatus } from './tui';

interface ServerConfig {
  port: number;
  wsPath: string;
  heartbeatInterval: number;
}

export class ProxyServer {
  private config: ServerConfig;
  private deviceManager: DeviceManager;
  private messageRouter: MessageRouter;
  private wss: WebSocketServer | null;
  private heartbeatTimer: NodeJS.Timeout | null;
  private tui: Tui | null;

  constructor(customConfig: Partial<ServerConfig>) {
    const defaultConfig: ServerConfig = {
      port: 3000,
      wsPath: '/ws',
      heartbeatInterval: 30000
    };

    this.config = { ...defaultConfig, ...customConfig };
    this.deviceManager = new DeviceManager();
    this.messageRouter = new MessageRouter(this.deviceManager);
    this.wss = null;
    this.heartbeatTimer = null;
    this.tui = null;
  }

  // 启动服务器
  start(): void {
    // 创建 WebSocket 服务器
    this.wss = new WebSocketServer({
      port: this.config.port,
      path: this.config.wsPath,
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (error: Error) => {
      Utils.log(`服务器错误: ${error.message}`, 'error');
    });

    // 启动心跳检测
    this.startHeartbeatCheck();

    Utils.log(`代理服务器启动成功`, 'success');
    Utils.log(`监听端口: ${this.config.port}`, 'info');
    this.displayConnectionInfo();
  }

  // 处理新连接
  handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const clientType = url.searchParams.get('type'); // 'miniapp' or 'simulator'

    Utils.log(`新连接: ${clientType || 'unknown'}`, 'info');

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        this.messageRouter.handleMessage(message, ws);
      } catch (error) {
        Utils.log(`消息解析失败: ${(error as Error).message}`, 'error');
      }
    });

    ws.on('close', () => {
      this.deviceManager.disconnect(ws);
      this.messageRouter.clearPendingCallsForWS(ws);
    });

    ws.on('error', (error: Error) => {
      Utils.log(`WebSocket错误: ${error.message}`, 'error');
    });
  }

  // 连接信息：serverUrl 与二维码文本的唯一来源，TUI 与纯文本头部共用。
  // 两条路径各自拼装的话，appId 或 IP 一旦不一致就会得到两个不同的二维码
  buildConnectionInfo(): { serverUrl: string; qrText: string } {
    const localIP = Utils.getLocalIP();
    const serverUrl = Utils.formatServerUrl(localIP, this.config.port, '');

    let qrText = '';
    const qrData = `xlmpaas://${config.appId}?url=${encodeURIComponent(serverUrl)}`;
    // 必须用回调形式取字符串：直接打印会把二维码写进日志滚动区，而不是固定在头部
    QRCode.generate(qrData, { small: true }, (qr) => {
      qrText = qr;
    });

    return { serverUrl, qrText };
  }

  // 连接状态快照，供 TUI 状态轮询调用
  getStatus(): ProxyStatus {
    let deviceCount = 0;
    let simulatorCount = 0;
    // 用 devicesMap 而非 getAllDevices()：后者只带 hasMiniapp，拿不到模拟器连接状态
    for (const device of this.deviceManager.devicesMap.values()) {
      if (device.ws) deviceCount++;
      if (device.simulatorWS) simulatorCount++;
    }
    return { deviceCount, simulatorCount, port: this.config.port };
  }

  // 接管终端输出：设置后由 Tui 自行绘制头部，本类不再打印
  setTui(tui: Tui | null): void {
    this.tui = tui;
  }

  // 显示连接信息
  displayConnectionInfo(): void {
    // 头部已由 tui.start() 画好，再打印一次会在滚动区里重复一遍框线与二维码
    if (this.tui) return;
    this.printPlainHeader();
  }

  // 纯文本头部：无 TUI 时的降级输出，与接入 TUI 前逐字一致
  printPlainHeader(): void {
    const { serverUrl, qrText } = this.buildConnectionInfo();

    console.log(`
╔════════════════════════════════════════════════════════════╗
║            mPaaS JSAPI 代理服务器                          ║
╠════════════════════════════════════════════════════════════╣
║  请在代理小程序中输入以下地址进行注册                      ║
║                                                            ║
║  ${serverUrl.padEnd(58)}║
║                                                            ║
║  或扫描下方二维码快速配置：                                  ║
╚════════════════════════════════════════════════════════════╝
    `);

    // 生成二维码
    console.log('');
    console.log(qrText);
  }

  // 启动心跳检测
  startHeartbeatCheck(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const timeout = this.config.heartbeatInterval * 2;

      for (const [deviceId, device] of this.deviceManager.devicesMap) {
        if (now - device.lastHeartbeat > timeout) {
          Utils.log(`设备心跳超时: ${deviceId}`, 'warn');
          if (device.ws) {
            device.ws.close();
          }
          if (device.simulatorWS) {
            device.simulatorWS.close();
          }
          this.deviceManager.devicesMap.delete(deviceId);
        }
      }
    }, this.config.heartbeatInterval);
  }

  // 停止服务器
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.wss) {
      this.wss.close();
      Utils.log('服务器已关闭', 'info');
    }
  }
}
