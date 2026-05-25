const { Storage } = require('../../utils/storage');

Page({
  data: {
    deviceId: '',
    serverUrl: 'ws://192.168.1.100:3000',
    connectionStatus: '未连接',
    statusClass: 'disconnected'
  },

  onLoad() {
    this.deviceId = Storage.getDeviceId();
    this.setData({ deviceId });
    this.heartbeatTimer = null;
  },

  onUnload() {
    this.disconnect();
  },

  onServerUrlInput(e) {
    this.setData({ serverUrl: e.detail.value });
  },

  connect() {
    const serverUrl = this.data.serverUrl.trim();
    if (!serverUrl) {
      my.showToast({ content: '请输入服务器地址', duration: 2000 });
      return;
    }

    this.setData({ connectionStatus: '连接中', statusClass: 'connecting' });

    const wsUrl = serverUrl + '/ws?type=miniapp';

    my.connectSocket({
      url: wsUrl,
      success: () => {
        console.log('WebSocket 连接创建成功');
      },
      fail: (err) => {
        console.error('WebSocket 连接失败', err);
        this.setData({ connectionStatus: '连接失败', statusClass: 'error' });
        my.showToast({ content: '连接失败: ' + JSON.stringify(err), duration: 3000 });
      }
    });

    my.onSocketOpen(() => {
      console.log('WebSocket 连接已打开');
      this.register();
    });

    my.onSocketMessage((res) => {
      try {
        const message = JSON.parse(res.data);
        this.handleMessage(message);
      } catch (error) {
        console.error('消息解析失败', error);
      }
    });

    my.onSocketError((err) => {
      console.error('WebSocket 错误', err);
      this.setData({ connectionStatus: '连接错误', statusClass: 'error' });
      my.showToast({ content: '连接错误', duration: 2000 });
    });

    my.onSocketClose(() => {
      console.log('WebSocket 连接已关闭');
      this.setData({ connectionStatus: '已断开', statusClass: 'disconnected' });
      this.stopHeartbeat();
    });
  },

  register() {
    const deviceInfo = Storage.getDeviceInfo();
    const message = {
      type: 'register',
      msgId: 'msg_register_' + Date.now(),
      deviceId: this.deviceId,
      timestamp: Date.now(),
      deviceInfo: deviceInfo
    };

    my.sendSocketMessage({
      data: JSON.stringify(message),
      success: () => {
        console.log('注册消息已发送');
      },
      fail: (err) => {
        console.error('注册消息发送失败', err);
      }
    });
  },

  handleMessage(message) {
    const { type, msgId } = message;

    switch (type) {
      case 'register':
        if (message.success) {
          this.setData({
            connectionStatus: '已连接',
            statusClass: 'connected'
          });
          my.showToast({ content: '注册成功！', duration: 2000 });
          this.startHeartbeat();
        }
        break;

      case 'call':
        this.handleApiCall(message);
        break;

      case 'error':
        console.error('收到错误消息', message);
        my.showToast({ content: message.error.message || '发生错误', duration: 2000 });
        break;

      default:
        console.log('未处理的消息类型', type);
    }
  },

  handleApiCall(message) {
    const { msgId, api, params } = message;

    console.log('执行 API 调用:', api, params);

    my.call(api, params || {}, (result) => {
      console.log('API 返回结果:', result);

      const response = {
        type: 'response',
        msgId: msgId,
        deviceId: this.deviceId,
        timestamp: Date.now(),
        result: result
      };

      my.sendSocketMessage({
        data: JSON.stringify(response),
        fail: (err) => {
          console.error('响应发送失败', err);
        }
      });
    });
  },

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const heartbeatMsg = {
        type: 'heartbeat',
        msgId: 'heartbeat_' + Date.now(),
        deviceId: this.deviceId,
        timestamp: Date.now()
      };

      my.sendSocketMessage({
        data: JSON.stringify(heartbeatMsg),
        fail: (err) => {
          console.error('心跳发送失败', err);
        }
      });
    }, 30000);
  },

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  },

  disconnect() {
    this.stopHeartbeat();
    my.closeSocket();
    this.setData({ connectionStatus: '未连接', statusClass: 'disconnected' });
    my.showToast({ content: '已断开连接', duration: 2000 });
  },

  copyDeviceId() {
    my.setClipboard({
      text: this.deviceId
    });
    my.showToast({ content: '设备ID已复制', duration: 1500 });
  }
});
