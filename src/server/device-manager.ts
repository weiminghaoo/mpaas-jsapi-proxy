import { Utils } from './utils';
import type { WebSocket } from 'ws';

export interface DeviceInfo {
  [key: string]: any;
}

export interface Device {
  ws: WebSocket | null;
  simulatorWS: WebSocket | null;
  deviceInfo: DeviceInfo;
  lastHeartbeat: number;
}

export class DeviceManager {
  private devices: Map<string, Device>;

  constructor() {
    this.devices = new Map();
  }

  // 注册设备（小程序连接）
  registerDevice(deviceId: string, ws: WebSocket, deviceInfo: DeviceInfo): void {
    // 如果设备已存在，更新连接
    if (this.devices.has(deviceId)) {
      const existing = this.devices.get(deviceId)!;
      existing.ws = ws;
      existing.deviceInfo = deviceInfo;
      existing.lastHeartbeat = Date.now();
      Utils.log(`设备更新连接: ${deviceId}`, 'info');
    } else {
      this.devices.set(deviceId, {
        ws,
        simulatorWS: null,
        deviceInfo,
        lastHeartbeat: Date.now(),
      });
      Utils.log(`设备注册成功: ${deviceId}`, 'success');
    }
  }

  // 断开连接
  disconnect(ws: WebSocket): boolean {
    for (const [deviceId, device] of this.devices) {
      if (device.ws === ws) {
        this.devices.delete(deviceId);
        Utils.log(`设备断开连接: ${deviceId}`, 'warn');
        return true;
      }
    }
    return false;
  }

  // 获取设备信息
  getDevice(deviceId: string): Device | undefined {
    return this.devices.get(deviceId);
  }

  // 检查设备是否就绪（小程序和模拟器都已连接）
  isDeviceReady(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    return !!device && !!device.ws;
  }

  // 更新心跳时间
  updateHeartbeat(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastHeartbeat = Date.now();
    }
  }

  // 获取所有设备状态
  getAllDevices(): Array<{ deviceId: string; hasMiniapp: boolean; lastHeartbeat: number }> {
    return Array.from(this.devices.entries()).map(([id, device]) => ({
      deviceId: id,
      hasMiniapp: !!device.ws,
      lastHeartbeat: device.lastHeartbeat,
    }));
  }

  // 暴露 devices 给 MessageRouter 使用
  get devicesMap(): Map<string, Device> {
    return this.devices;
  }
}
