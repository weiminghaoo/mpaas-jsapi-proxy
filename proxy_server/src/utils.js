const os = require('os');

class Utils {
  // 获取本地局域网IP地址
  static getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return 'localhost';
  }

  // 格式化服务器连接地址
  static formatServerUrl(ip, port, path) {
    return `ws://${ip}:${port}${path}`;
  }

  // 日志输出
  static log(message, type = 'info') {
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

module.exports = { Utils };
