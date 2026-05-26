const { Storage } = require('../../utils/storage')
const { parseUrlString } = require('/utils/urlParser')

// 客户端代理代码（用于复制到模拟器）
const CLIENT_PROXY_CODE = `class MyCallProxy {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.pendingCalls = new Map(); // msgId → { callback, timestamp }
    this.isConnected = false;
    this.isConnecting = false; // 连接中状态
    this.connectPromise = null; // 连接 Promise
    this.originalMyCall = null;
    this.msgIdCounter = 0;
    this._deviceIdCache = null; // 缓存解析后的 deviceId
  }

  // 初始化代理
  init() {
    if (typeof my === 'undefined' || typeof my.call !== 'function') {
      console.error('my.call 不存在，无法初始化代理');
      return false;
    }

    // 保存原始 my.call
    this.originalMyCall = my.call;

    // 劫持 my.call
    const self = this;
    my.call = function(api, params, callback) {
      if (self.isConnected) {
        self.proxyCall(api, params, callback);
      } else if (self.isConnecting) {
        // 连接中，等待连接完成
        console.log(\`[代理连接中] 等待连接: \${api}\`);
        self.waitForConnection().then(() => {
          console.log(\`[代理连接中] 连接完成，发送: \${api}\`);
          self.proxyCall(api, params, callback);
        });
      } else {
        console.warn('[代理未连接] 使用原始 my.call');
        self.originalMyCall.call(this, api, params, callback);
      }
    };

    this.connect();
    console.log('[MyCallProxy] ✅ my.call 代理已初始化');
    return true;
  }

  // 连接到代理服务器
  connect() {
    const deviceId = this.getDeviceId();

    if (!deviceId) {
      console.error('[MyCallProxy] 服务器URL中缺少deviceId参数');
      return;
    }

    console.log('[MyCallProxy] 设备ID:', deviceId);
    console.log('[MyCallProxy] 服务器URL:', this.serverUrl);

    const wsUrl = this.buildWebSocketUrl('/ws', { type: 'simulator' });
    console.log('[MyCallProxy] WebSocket URL:', wsUrl);

    // 创建连接 Promise
    this.isConnecting = true;
    this.connectPromise = new Promise((resolve, reject) => {
      this._resolveConnect = resolve;
      this._rejectConnect = reject;
    });

    try {
      my.connectSocket({
        url: wsUrl,
        success: () => {
          console.log('[MyCallProxy] WebSocket 连接创建成功');
        },
        fail: (err) => {
          console.error('[MyCallProxy] WebSocket 连接失败', err);
          this.isConnecting = false;
          this.isConnected = false;
          if (this._rejectConnect) {
            this._rejectConnect(err);
          }
        }
      });

      // 监听连接打开
      my.onSocketOpen(() => {
        console.log('[MyCallProxy] 🔗 已连接到代理服务器');
        this.isConnecting = false;
        this.isConnected = true;
        if (this._resolveConnect) {
          this._resolveConnect();
        }
      });

      // 监听消息
      my.onSocketMessage((res) => {
        try {
          const message = JSON.parse(res.data);
          this.handleMessage(message);
        } catch (error) {
          console.error('[MyCallProxy] 消息解析失败:', error);
        }
      });

      // 监听错误
      my.onSocketError((err) => {
        console.error('[MyCallProxy] WebSocket 错误:', err);
        this.isConnecting = false;
        this.isConnected = false;
        if (this._rejectConnect) {
          this._rejectConnect(err);
        }
      });

      // 监听关闭
      my.onSocketClose(() => {
        console.warn('[MyCallProxy] WebSocket 连接已关闭');
        this.isConnecting = false;
        this.isConnected = false;
        this.rejectPendingCalls('连接已断开');
      });
    } catch (error) {
      console.error('[MyCallProxy] 连接失败:', error);
      this.isConnecting = false;
      if (this._rejectConnect) {
        this._rejectConnect(error);
      }
    }
  }

  // 代理调用
  proxyCall(api, params, callback) {
    const msgId = this.generateMsgId();
    const deviceId = this.getDeviceId();

    if (!deviceId) {
      console.error('[MyCallProxy] 服务器URL中缺少deviceId参数');
      this.fallbackToOriginal(api, params, callback);
      return;
    }

    // 存储回调
    this.pendingCalls.set(msgId, {
      callback: callback || (() => {}),
      timestamp: Date.now()
    });

    const message = {
      type: 'client_call',
      msgId: msgId,
      deviceId: deviceId,
      timestamp: Date.now(),
      api: api,
      params: params || {}
    };

    try {
      my.sendSocketMessage({
        data: JSON.stringify(message),
        success: () => {
          console.log(\`[MyCallProxy] 📤 发送: \${api} (msgId: \${msgId})\`);
        },
        fail: (err) => {
          console.error('[MyCallProxy] 发送失败:', err);
          this.pendingCalls.delete(msgId);
          this.fallbackToOriginal(api, params, callback);
        }
      });
    } catch (error) {
      console.error('[MyCallProxy] 发送失败:', error);
      this.pendingCalls.delete(msgId);
      this.fallbackToOriginal(api, params, callback);
    }
  }

  // 处理响应消息
  handleMessage(message) {
    const { type, msgId, result, error } = message;

    if (type === 'response') {
      const pending = this.pendingCalls.get(msgId);
      if (pending) {
        console.log(\`[MyCallProxy] 📥 响应: \${msgId}\`);
        pending.callback(result);
        this.pendingCalls.delete(msgId);
      } else {
        console.warn(\`[MyCallProxy] 未找到对应的请求: \${msgId}\`);
      }
    } else if (type === 'error') {
      const pending = this.pendingCalls.get(msgId);
      if (pending) {
        console.error(\`[MyCallProxy] ❌ 错误: \${msgId}\`, error);
        pending.callback({ error: error });
        this.pendingCalls.delete(msgId);
      }
    }
  }

  // 回退到原始 my.call
  fallbackToOriginal(api, params, callback) {
    console.warn('[MyCallProxy] 回退到原始 my.call');
    if (this.originalMyCall) {
      this.originalMyCall.call(this, api, params, callback);
    }
  }

  // 拒绝所有等待中的调用
  rejectPendingCalls(reason) {
    for (const [msgId, pending] of this.pendingCalls) {
      pending.callback({ error: { message: reason } });
    }
    this.pendingCalls.clear();
  }

  // 生成消息ID
  generateMsgId() {
    return 'msg_' + Date.now() + '_' + (++this.msgIdCounter);
  }

  // 获取设备ID（带缓存）
  getDeviceId() {
    if (this._deviceIdCache) {
      return this._deviceIdCache;
    }

    const match = this.serverUrl.match(/[?&]deviceId=([^&]+)/);
    this._deviceIdCache = match ? match[1] : null;
    return this._deviceIdCache;
  }

  // 构建带路径和参数的 WebSocket URL
  buildWebSocketUrl(path, extraParams = {}) {
    const urlMatch = this.serverUrl.match(/^(https?:\\/\\/|wss?:\\/\\/)([^\\/?]+)(.*)$/);
    if (!urlMatch) {
      return this.serverUrl;
    }

    const [, protocol, host, rest] = urlMatch;

    let existingParams = {};
    const queryMatch = rest.match(/\\?([^#]*)/);
    if (queryMatch) {
      const queryString = queryMatch[1];
      queryString.split('&').forEach(param => {
        const [key, value] = param.split('=');
        if (key) {
          existingParams[key] = value || '';
        }
      });
    }

    const allParams = { ...existingParams, ...extraParams };
    const queryString = Object.entries(allParams)
      .map(([k, v]) => \`\${k}=\${v}\`)
      .join('&');

    return \`\${protocol}\${host}\${path}?\${queryString}\`;
  }

  // 等待连接完成
  waitForConnection() {
    if (!this.connectPromise) {
      return Promise.reject(new Error('连接未初始化'));
    }
    return this.connectPromise;
  }

  // 销毁代理
  destroy() {
    this.isConnected = false;
    this.isConnecting = false;
    my.closeSocket();
    if (this.originalMyCall) {
      my.call = this.originalMyCall;
    }
    this.rejectPendingCalls('代理已销毁');
    console.log('[MyCallProxy] 🔌 my.call 代理已销毁');
  }

  // 获取连接状态
  getStatus() {
    return {
      isConnected: this.isConnected,
      pending_calls: this.pendingCalls.size,
      serverUrl: this.serverUrl
    };
  }
}

// 使用方法：
// const proxy = new MyCallProxy('ws://192.168.1.100:3000?deviceId=device_xxx');
// proxy.init();`

Page({
  data: {
    deviceId: '',
    serverUrl: 'ws://192.168.1.100:3000',
    connectionStatus: '未连接',
    statusClass: 'disconnected',
    isConnected: false,
    scanIcon: '/assets/scan.svg',
  },

  onLoad() {
    const deviceId = Storage.getDeviceId()
    const cachedServerUrl = Storage.getServerUrl()
    this.setData({
      deviceId,
      serverUrl: cachedServerUrl || this.data.serverUrl,
    })
    this.heartbeatTimer = null
    this._isConnecting = false
    this._hasSetupListeners = false

    my.setKeepScreenOn({
      keepScreenOn: true,
    })

    // 只在页面加载时设置一次事件监听器
    this.setupSocketListeners()
  },

  // 设置 WebSocket 事件监听器（只调用一次）
  setupSocketListeners() {
    if (this._hasSetupListeners) {
      return
    }

    my.onSocketOpen(() => {
      console.log('WebSocket 连接已打开')
      this._isConnecting = false
      this.register()
    })

    my.onSocketMessage((res) => {
      try {
        const message = JSON.parse(res.data)
        this.handleMessage(message)
      } catch (error) {
        console.error('消息解析失败', error)
      }
    })

    my.onSocketError((err) => {
      console.error('WebSocket 错误', err)
      this.setData({
        connectionStatus: '连接错误',
        statusClass: 'error',
        isConnected: false,
      })
      my.showToast({ content: '连接错误', duration: 2000 })
      this._isConnecting = false
    })

    my.onSocketClose(() => {
      console.log('WebSocket 连接已关闭')
      this.setData({
        connectionStatus: '已断开',
        statusClass: 'disconnected',
        isConnected: false,
      })
      this.stopHeartbeat()
      this._isConnecting = false
    })

    this._hasSetupListeners = true
  },

  onUnload() {
    this.disconnect()
    my.setKeepScreenOn({
      keepScreenOn: false,
    })
  },

  onServerUrlInput(e) {
    this.setData({ serverUrl: e.detail.value })
  },

  connect() {
    const serverUrl = this.data.serverUrl.trim()
    if (!serverUrl) {
      my.showToast({ content: '请输入服务器地址', duration: 2000 })
      return
    }

    // 防止重复连接
    if (this._isConnecting) {
      console.log('正在连接中，请勿重复点击')
      return
    }

    this._isConnecting = true
    this.setData({ connectionStatus: '连接中', statusClass: 'connecting' })

    const wsUrl = serverUrl + '/ws?type=miniapp'

    my.connectSocket({
      url: wsUrl,
      success: () => {
        console.log('WebSocket 连接创建成功')
      },
      fail: (err) => {
        console.error('WebSocket 连接失败', err)
        this.setData({
          connectionStatus: '连接失败',
          statusClass: 'error',
          isConnected: false,
        })
        my.showToast({ content: '连接失败: ' + JSON.stringify(err), duration: 3000 })
        this._isConnecting = false
      },
    })
  },

  register() {
    const deviceInfo = Storage.getDeviceInfo()
    const message = {
      type: 'register',
      msgId: 'msg_register_' + Date.now(),
      deviceId: this.data.deviceId,
      timestamp: Date.now(),
      deviceInfo: deviceInfo,
    }

    my.sendSocketMessage({
      data: JSON.stringify(message),
      success: () => {
        console.log('注册消息已发送')
      },
      fail: (err) => {
        console.error('注册消息发送失败', err)
      },
    })
  },

  handleMessage(message) {
    const { type, msgId } = message

    switch (type) {
      case 'register':
        if (message.success) {
          Storage.saveServerUrl(this.data.serverUrl)
          this.setData({
            connectionStatus: '已连接',
            statusClass: 'connected',
            isConnected: true,
          })
          my.showToast({ content: '注册成功！', duration: 2000 })
          this.startHeartbeat()
        }
        break

      case 'client_call':
        this.handleApiCall(message)
        break

      case 'error':
        console.error('收到错误消息', message)
        my.showToast({ content: message.error.message || '发生错误', duration: 2000 })
        break

      default:
        console.log('未处理的消息类型', type)
    }
  },

  handleApiCall(message) {
    const { msgId, api, params } = message

    console.log('执行 API 调用:', api, params)

    my.call(api, params || {}, (result) => {
      console.log('API 返回结果:', result)

      const response = {
        type: 'response',
        msgId: msgId,
        deviceId: this.data.deviceId,
        timestamp: Date.now(),
        result: result,
      }

      my.sendSocketMessage({
        data: JSON.stringify(response),
        fail: (err) => {
          console.error('响应发送失败', err)
        },
      })
    })
  },

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      const heartbeatMsg = {
        type: 'heartbeat',
        msgId: 'heartbeat_' + Date.now(),
        deviceId: this.data.deviceId,
        timestamp: Date.now(),
      }

      my.sendSocketMessage({
        data: JSON.stringify(heartbeatMsg),
        fail: (err) => {
          console.error('心跳发送失败', err)
        },
      })
    }, 30000)
  },

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  },

  disconnect() {
    this.stopHeartbeat()
    my.closeSocket()
    this.setData({
      connectionStatus: '未连接',
      statusClass: 'disconnected',
      isConnected: false,
    })
    my.showToast({ content: '已断开连接', duration: 2000 })
  },

  copyConnectionParams() {
    const connectionParams = `${this.data.serverUrl}?deviceId=${this.data.deviceId}`
    my.setClipboard({
      text: connectionParams,
    })
    my.showToast({ content: '连接参数已复制', duration: 1500 })
  },

  copyInstallCommand() {
    my.setClipboard({
      text: 'npm install -g mpaas-jsapi-proxy',
    })
    my.showToast({ content: '安装命令已复制', duration: 1500 })
  },

  copyStartCommand() {
    my.setClipboard({
      text: 'mpaas-jsapi-proxy',
    })
    my.showToast({ content: '启动命令已复制', duration: 1500 })
  },

  copyClientProxyCode() {
    my.setClipboard({
      text: CLIENT_PROXY_CODE,
    })
    my.showToast({ content: '客户端代码已复制', duration: 1500 })
  },

  scanQRCode() {
    my.scan({
      type: 'qr',
      success: (res) => {
        const code = res.code
        console.log('扫码结果:', code)
        const urlParams = parseUrlString(code)

        // 解析 URL 中的参数 url=ws://192.168.0.12:3000
        if (urlParams.url) {
          const decodedUrl = urlParams.url
          console.log('解析后的 URL:', decodedUrl)
          if (decodedUrl.startsWith('ws://') || decodedUrl.startsWith('wss://')) {
            this.setData({ serverUrl: decodedUrl })
            my.showToast({ content: '已自动填入服务器地址', duration: 1500 })
            return
          }
        }
        my.showToast({ content: '无效的二维码格式', duration: 2000 })
      },
      fail: () => {
        my.showToast({ content: '扫码失败，请重试', duration: 2000 })
      },
    })
  },
})
