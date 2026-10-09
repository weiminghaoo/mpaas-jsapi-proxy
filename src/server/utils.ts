import os from 'os';
import type { NetworkInterfaceInfo } from 'os';

// 日志级别
export type LogType = 'info' | 'success' | 'error' | 'warn';

// 日志出口：接收已格式化的一行文本
export type LogSink = (line: string) => void;

export class Utils {
  // 各级别图标
  private static readonly ICONS: Record<LogType, string> = {
    info: 'ℹ️',
    success: '✅',
    error: '❌',
    warn: '⚠️'
  };

  // 自定义日志出口，null 表示使用默认的 console.log
  private static logSink: LogSink | null = null;

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

  // 格式化一行日志：[HH:MM:SS] <图标> <message>
  static formatLogLine(message: string, type: LogType = 'info'): string {
    const timestamp = new Date().toLocaleTimeString('zh-CN');
    return `[${timestamp}] ${Utils.ICONS[type]} ${message}`;
  }

  // 设置日志出口，传 null 恢复默认 console.log
  static setLogSink(sink: LogSink | null): void {
    Utils.logSink = sink;
  }

  // 日志输出
  static log(message: string, type: LogType = 'info'): void {
    const line = Utils.formatLogLine(message, type);
    if (Utils.logSink) {
      Utils.logSink(line);
    } else {
      console.log(line);
    }
  }
}
