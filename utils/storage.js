const DEVICE_ID_KEY = 'proxy_device_id';

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

  // 清除设备ID（用于测试）
  static clearDeviceId() {
    my.removeStorageSync({ key: DEVICE_ID_KEY });
  }
}

module.exports = { Storage };
