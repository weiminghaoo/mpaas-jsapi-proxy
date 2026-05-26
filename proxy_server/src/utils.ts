import os from 'os';
import type { NetworkInterfaceInfo } from 'os';

export class Utils {
  // 获取本地局域网IP地址
  static getLocalIP(): string {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]!) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return 'localhost';
  }

  // 格式化服务器连接地址
  static formatServerUrl(ip: string, port: number, path: string): string {
    return `ws://${ip}:${port}${path}`;
  }

  // 日志输出
  static log(message: string, type: 'info' | 'success' | 'error' | 'warn' = 'info'): void {
    const timestamp = new Date().toLocaleTimeString('zh-CN');
    const icons = {
      info: 'ℹ️',
      success: '✅',
      error: '❌',
      warn: '⚠️'
    };
    console.log(`[${timestamp}] ${icons[type] || 'ℹ️'} ${message}`);
  }
}
