const WebSocket = require('ws');
const QRCode = require('qrcode-terminal');
const { DeviceManager } = require('./device-manager');
const { MessageRouter } = require('./message-router');
const { Utils } = require('./utils');
const config = require('../config');

class ProxyServer {
  constructor(customConfig) {
    this.config = { ...config, ...customConfig };
    this.deviceManager = new DeviceManager();
    this.messageRouter = new MessageRouter(this.deviceManager);
    this.wss = null;
    this.heartbeatTimer = null;
  }

  // 启动服务器
  start() {
    // 创建 WebSocket 服务器
    this.wss = new WebSocket.Server({
      port: this.config.port,
      path: this.config.wsPath
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (error) => {
      Utils.log(`服务器错误: ${error.message}`, 'error');
    });

    // 启动心跳检测
    this.startHeartbeatCheck();

    Utils.log(`代理服务器启动成功`, 'success');
    Utils.log(`监听端口: ${this.config.port}`, 'info');
    this.displayConnectionInfo();
  }

  // 处理新连接
  handleConnection(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const clientType = url.searchParams.get('type'); // 'miniapp' or 'simulator'

    Utils.log(`新连接: ${clientType || 'unknown'}`, 'info');

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        this.messageRouter.handleMessage(message, ws);
      } catch (error) {
        Utils.log(`消息解析失败: ${error.message}`, 'error');
      }
    });

    ws.on('close', () => {
      this.deviceManager.disconnect(ws);
      this.messageRouter.clearPendingCallsForWS(ws);
    });

    ws.on('error', (error) => {
      Utils.log(`WebSocket错误: ${error.message}`, 'error');
    });
  }

  // 显示连接信息
  displayConnectionInfo() {
    const localIP = Utils.getLocalIP();
    const serverUrl = Utils.formatServerUrl(localIP, this.config.port,'');

    console.log(`
╔════════════════════════════════════════════════════════════╗
║            mPaaS JSAPI 代理服务器                          ║
╠════════════════════════════════════════════════════════════╣
║  请在代理小程序中输入以下地址进行注册                      ║
║                                                            ║
║  ${serverUrl.padEnd(58)}║                                                   ║
║                                                            ║
║  或扫描下方二维码快速配置：                                  ║
╚════════════════════════════════════════════════════════════╝
    `);

    // 生成二维码
    console.log('');
    const qrData = JSON.stringify({
      url: encodeURIComponent(serverUrl)
    });
    QRCode.generate(qrData, { small: true });
  }

  // 启动心跳检测
  startHeartbeatCheck() {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const timeout = this.config.heartbeatInterval * 2;

      for (const [deviceId, device] of this.deviceManager.devices) {
        if (now - device.lastHeartbeat > timeout) {
          Utils.log(`设备心跳超时: ${deviceId}`, 'warn');
          if (device.ws) {
            device.ws.close();
          }
          if (device.simulatorWS) {
            device.simulatorWS.close();
          }
          this.deviceManager.devices.delete(deviceId);
        }
      }
    }, this.config.heartbeatInterval);
  }

  // 停止服务器
  stop() {
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

module.exports = { ProxyServer };
