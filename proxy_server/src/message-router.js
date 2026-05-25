const { Utils } = require('./utils');

class MessageRouter {
  constructor(deviceManager) {
    this.deviceManager = deviceManager;
  }

  // 处理接收到的消息
  handleMessage(message, ws) {
    const { type, msgId, deviceId } = message;

    if (!type || !msgId) {
      this.sendError(ws, msgId, 'INVALID_MESSAGE', '消息格式错误');
      return;
    }

    switch (type) {
      case 'register':
        this.handleRegister(message, ws);
        break;
      case 'call':
        this.handleCall(message, ws);
        break;
      case 'response':
        this.handleResponse(message, ws);
        break;
      case 'heartbeat':
        this.handleHeartbeat(message);
        break;
      default:
        this.sendError(ws, msgId, 'UNKNOWN_MESSAGE_TYPE', `未知消息类型: ${type}`);
    }
  }

  // 处理设备注册
  handleRegister(message, ws) {
    const { msgId, deviceId, deviceInfo } = message;

    if (!deviceId) {
      this.sendError(ws, msgId, 'INVALID_DEVICE_ID', '设备ID不能为空');
      return;
    }

    this.deviceManager.registerDevice(deviceId, ws, deviceInfo);

    // 发送注册成功响应
    ws.send(JSON.stringify({
      type: 'register',
      msgId: msgId,
      deviceId: deviceId,
      success: true,
      timestamp: Date.now()
    }));
  }

  // 处理 API 调用（来自模拟器）
  handleCall(message, ws) {
    const { msgId, deviceId, api, params } = message;

    if (!deviceId) {
      this.sendError(ws, msgId, 'INVALID_DEVICE_ID', '设备ID不能为空');
      return;
    }

    const device = this.deviceManager.getDevice(deviceId);
    if (!device || !device.miniappWS) {
      this.sendError(ws, msgId, 'DEVICE_OFFLINE', '代理小程序未连接');
      return;
    }

    // 转发到小程序
    try {
      device.miniappWS.send(JSON.stringify(message));
      Utils.log(`转发调用: ${api} → ${deviceId}`, 'info');
    } catch (error) {
      this.sendError(ws, msgId, 'SEND_FAILED', `发送失败: ${error.message}`);
    }
  }

  // 处理响应消息（来自小程序）
  handleResponse(message, ws) {
    const { deviceId } = message;

    const device = this.deviceManager.getDevice(deviceId);
    if (!device || !device.simulatorWS) {
      Utils.log(`无模拟器连接，丢弃响应: ${deviceId}`, 'warn');
      return;
    }

    // 转发到模拟器
    try {
      device.simulatorWS.send(JSON.stringify(message));
      Utils.log(`转发响应 → ${deviceId}`, 'info');
    } catch (error) {
      Utils.log(`转发响应失败: ${error.message}`, 'error');
    }
  }

  // 处理心跳
  handleHeartbeat(message) {
    const { deviceId } = message;
    this.deviceManager.updateHeartbeat(deviceId);
  }

  // 发送错误消息
  sendError(ws, msgId, code, message) {
    if (ws && ws.readyState === 1) { // WebSocket.OPEN
      ws.send(JSON.stringify({
        type: 'error',
        msgId: msgId,
        timestamp: Date.now(),
        error: {
          code: code,
          message: message
        }
      }));
    }
  }
}

module.exports = { MessageRouter };
