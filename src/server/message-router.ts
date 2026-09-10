import { Utils } from './utils';
import type { DeviceManager } from './device-manager';
import type { WebSocket } from 'ws';

interface Message {
  type: string;
  msgId: string;
  deviceId?: string;
  deviceInfo?: any;
  api?: string;
  params?: any;
  error?: {
    code: string;
    message: string;
  };
  success?: boolean;
  role?: string;
  proxyMode?: string;
  data?: any;
  timestamp?: number;
}

interface PendingCall {
  ws: WebSocket;
  deviceId: string;
  timestamp: number;
}

export class MessageRouter {
  private deviceManager: DeviceManager;
  private httpServer: any = null;
  private pendingCalls: Map<string, PendingCall>;

  constructor(deviceManager: DeviceManager) {
    this.deviceManager = deviceManager;
    this.pendingCalls = new Map();
  }

  setHttpServer(httpServer: any): void {
    this.httpServer = httpServer;
  }

  handleMessage(message: any, ws: WebSocket): void {
    const { type, msgId, deviceId } = message;

    if (!type || !msgId) {
      this.sendError(ws, msgId, 'INVALID_MESSAGE', '消息格式错误');
      return;
    }

    switch (type) {
      case 'client_call':
        this.handleClientCall(message, ws);
        break;
      case 'register':
        this.handleRegister(message, ws);
        break;
      case 'response':
        this.handleResponse(message, ws);
        break;
      case 'event':
        this.handleEvent(message);
        break;
      case 'error':
        this.handlePhoneError(message);
        break;
      case 'heartbeat':
        this.handleHeartbeat(message);
        break;
      default:
        this.sendError(ws, msgId, 'UNKNOWN_MESSAGE_TYPE', `未知消息类型: ${type}`);
    }
  }

  // 处理设备注册
  handleRegister(message: Message, ws: WebSocket): void {
    const { msgId, deviceId, deviceInfo } = message;

    if (!deviceId) {
      this.sendError(ws, msgId!, 'INVALID_DEVICE_ID', '设备ID不能为空');
      return;
    }

    if (message.role === 'simulator') {
      this.deviceManager.registerSimulator(deviceId, ws);
    } else {
      this.deviceManager.registerDevice(deviceId, ws, deviceInfo || {});
    }

    // 发送注册成功响应
    ws.send(
      JSON.stringify({
        type: 'register',
        msgId: msgId,
        deviceId: deviceId,
        success: true,
        timestamp: Date.now(),
      }),
    );
  }

  // 处理 API 调用（来自模拟器）
  handleClientCall(message: Message, ws: WebSocket): void {
    const { msgId, deviceId, api, params } = message;

    if (!deviceId) {
      this.sendError(ws, msgId!, 'INVALID_DEVICE_ID', '设备ID不能为空', api);
      return;
    }

    // 事件订阅永无 response，不登记 pendingCalls（避免句柄泄漏）
    if (message.proxyMode !== 'event') {
      this.pendingCalls.set(msgId!, {
        ws,
        deviceId,
        timestamp: Date.now()
      });
    }

    const device = this.deviceManager.getDevice(deviceId);
    if (!device || !device.ws) {
      this.pendingCalls.delete(msgId!);
      this.sendError(ws, msgId!, 'DEVICE_OFFLINE', '代理小程序未连接', api);
      return;
    }

    // 转发到小程序
    try {
      device.ws.send(JSON.stringify(message));
      Utils.log(`转发调用: ${api} → ${deviceId} -> ${msgId}`, 'info');
    } catch (error) {
      this.pendingCalls.delete(msgId!);
      this.sendError(ws, msgId!, 'SEND_FAILED', `发送失败: ${(error as Error).message}`, api);
    }
  }

  handleResponse(message: Message, ws: WebSocket): void {
    const { msgId } = message;

    const caller = this.pendingCalls.get(msgId!);
    if (!caller) {
      Utils.log(`未找到对应的请求: ${msgId}`, 'warn');
      return;
    }

    Utils.log(`转发响应 → msgId: ${msgId}`, 'info');
    try {
      caller.ws.send(JSON.stringify(message));
    } catch (error) {
      Utils.log(`转发响应失败: ${(error as Error).message}`, 'error');
    } finally {
      this.pendingCalls.delete(msgId!);
    }
  }

  // 处理真机事件：按 deviceId 推送到该设备的模拟器连接
  handleEvent(message: Message): void {
    const { deviceId, api } = message;

    if (!deviceId) {
      return;
    }

    const device = this.deviceManager.getDevice(deviceId);
    if (!device || !device.simulatorWS || device.simulatorWS.readyState !== 1) {
      // readyState !== 1 即 WebSocket.OPEN
      Utils.log(`事件无处推送: ${api} @ ${deviceId}`, 'warn');
      return;
    }

    try {
      device.simulatorWS.send(JSON.stringify(message));
      Utils.log(`推送事件: ${api} → 模拟器 (${deviceId})`, 'info');
    } catch (error) {
      Utils.log(`事件推送失败: ${(error as Error).message}`, 'error');
    }
  }

  // 处理真机上报的错误（如事件订阅被拒绝）：按 deviceId 转发给模拟器
  handlePhoneError(message: Message): void {
    const { deviceId } = message;

    if (!deviceId) {
      return;
    }

    const device = this.deviceManager.getDevice(deviceId);
    if (!device || !device.simulatorWS || device.simulatorWS.readyState !== 1) {
      // readyState !== 1 即 WebSocket.OPEN
      return;
    }

    try {
      device.simulatorWS.send(JSON.stringify(message));
    } catch (error) {
      Utils.log(`错误转发失败: ${(error as Error).message}`, 'error');
    }
  }

  // 处理心跳
  handleHeartbeat(message: Message): void {
    const { deviceId } = message;
    if (deviceId) {
      this.deviceManager.updateHeartbeat(deviceId);
    }
  }

  // 发送错误消息（api 可选：事件订阅错误据此回传，客户端无 pendingCalls 也能定位是哪条订阅）
  sendError(ws: WebSocket, msgId: string | undefined, code: string, message: string, api?: string): void {
    if (ws && ws.readyState === 1) {
      // WebSocket.OPEN
      ws.send(
        JSON.stringify({
          type: 'error',
          msgId: msgId,
          api: api,
          timestamp: Date.now(),
          error: {
            code: code,
            message: message,
          },
        }),
      );
    }
  }

  // 清理指定 WebSocket 的待处理调用
  clearPendingCallsForWS(ws: WebSocket): void {
    for (const [msgId, caller] of this.pendingCalls) {
      if (caller.ws === ws) {
        this.pendingCalls.delete(msgId);
      }
    }
  }
}
