const DEVICE_ID_KEY = 'proxy_device_id';
const SERVER_URL_KEY = 'proxy_server_url';

class Storage {
  // 生成唯一设备ID
  static generateDeviceId() {
    return 'device_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  // 获取或创建设备ID
  static getDeviceId() {
    let deviceId = my.getStorageSync({ key: DEVICE_ID_KEY }).data;
    if (!deviceId) {
      deviceId = this.generateDeviceId();
      my.setStorageSync({
        key: DEVICE_ID_KEY,
        data: deviceId
      });
      console.log('生成新设备ID:', deviceId);
    } else {
      console.log('使用已存在设备ID:', deviceId);
    }
    return deviceId;
  }

  // 获取设备信息
  static getDeviceInfo() {
    const systemInfo = my.getSystemInfoSync();
    return {
      model: systemInfo.model,
      system: systemInfo.system,
      platform: systemInfo.platform,
      appVersion: systemInfo.version
    };
  }

  static clearDeviceId() {
    my.removeStorageSync({ key: DEVICE_ID_KEY });
  }

  static saveServerUrl(serverUrl) {
    my.setStorageSync({
      key: SERVER_URL_KEY,
      data: serverUrl
    });
    console.log('服务器URL已保存:', serverUrl);
  }

  static getServerUrl() {
    const result = my.getStorageSync({ key: SERVER_URL_KEY });
    const serverUrl = result.data;
    if (serverUrl) {
      console.log('使用缓存服务器URL:', serverUrl);
    }
    return serverUrl;
  }

  static clearServerUrl() {
    my.removeStorageSync({ key: SERVER_URL_KEY });
  }
}

module.exports = { Storage };
