class MyCallProxy {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.pendingCalls = new Map(); // msgId → { callback, timestamp }
    this.isConnected = false;
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
    //格式ws://192.168.0.12:3000?deviceId=device_1779703395901_iwzohax69
    const deviceId = this.getDeviceId();

    if (!deviceId) {
      console.error('[MyCallProxy] 服务器URL中缺少deviceId参数');
      return;
    }

    console.log('[MyCallProxy] 设备ID:', deviceId);
    console.log('[MyCallProxy] 服务器URL:', this.serverUrl);

    const wsUrl = this.buildWebSocketUrl('/ws', { type: 'simulator' });
    console.log('[MyCallProxy] WebSocket URL:', wsUrl);

    try {
      my.connectSocket({
        url: wsUrl,
        success: () => {
          console.log('[MyCallProxy] WebSocket 连接创建成功');
        },
        fail: (err) => {
          console.error('[MyCallProxy] WebSocket 连接失败', err);
          this.isConnected = false;
        }
      });

      // 监听连接打开
      my.onSocketOpen(() => {
        console.log('[MyCallProxy] 🔗 已连接到代理服务器');
        this.isConnected = true;
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
        this.isConnected = false;
      });

      // 监听关闭
      my.onSocketClose(() => {
        console.warn('[MyCallProxy] WebSocket 连接已关闭');
        this.isConnected = false;
        this.rejectPendingCalls('连接已断开');
      });
    } catch (error) {
      console.error('[MyCallProxy] 连接失败:', error);
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
          console.log(`[MyCallProxy] 📤 发送: ${api} (msgId: ${msgId})`);
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
        console.log(`[MyCallProxy] 📥 响应: ${msgId}`);
        pending.callback(result);
        this.pendingCalls.delete(msgId);
      } else {
        console.warn(`[MyCallProxy] 未找到对应的请求: ${msgId}`);
      }
    } else if (type === 'error') {
      const pending = this.pendingCalls.get(msgId);
      if (pending) {
        console.error(`[MyCallProxy] ❌ 错误: ${msgId}`, error);
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
    // 返回缓存值
    if (this._deviceIdCache) {
      return this._deviceIdCache;
    }

    // 使用正则表达式提取，兼容所有协议（ws://, http:// 等）
    const match = this.serverUrl.match(/[?&]deviceId=([^&]+)/);
    this._deviceIdCache = match ? match[1] : null;
    return this._deviceIdCache;
  }

  // 构建带路径和参数的 WebSocket URL
  buildWebSocketUrl(path, extraParams = {}) {
    // 解析基础 URL: ws://host:port?existing=params
    const urlMatch = this.serverUrl.match(/^(https?:\/\/|wss?:\/\/)([^\/?]+)(.*)$/);
    if (!urlMatch) {
      return this.serverUrl;
    }

    const [, protocol, host, rest] = urlMatch;

    // 提取现有查询参数
    let existingParams = {};
    const queryMatch = rest.match(/\?([^#]*)/);
    if (queryMatch) {
      const queryString = queryMatch[1];
      queryString.split('&').forEach(param => {
        const [key, value] = param.split('=');
        if (key) {
          existingParams[key] = value || '';
        }
      });
    }

    // 合并参数
    const allParams = { ...existingParams, ...extraParams };
    const queryString = Object.entries(allParams)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    // 构建最终 URL: ws://host:port/path?params
    return `${protocol}${host}${path}?${queryString}`;
  }

  // 从服务器URL提取设备ID（保留用于兼容性）
  extractDeviceId(url) {
    const match = url.match(/[?&]deviceId=([^&]+)/);
    return match ? match[1] : null;
  }

  // 销毁代理
  destroy() {
    this.isConnected = false;
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

// 支持 CommonJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MyCallProxy };
}
