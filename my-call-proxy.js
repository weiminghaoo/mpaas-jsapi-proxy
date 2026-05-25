class MyCallProxy {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.ws = null;
    this.pendingCalls = new Map(); // msgId → { callback, timestamp }
    this.isConnected = false;
    this.originalMyCall = null;
    this.msgIdCounter = 0;
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
    const wsUrl = this.serverUrl + '/ws?type=simulator';

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[MyCallProxy] 🔗 已连接到代理服务器');
        this.isConnected = true;
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error('[MyCallProxy] 消息解析失败:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('[MyCallProxy] WebSocket 错误:', error);
        this.isConnected = false;
      };

      this.ws.onclose = () => {
        console.warn('[MyCallProxy] WebSocket 连接已关闭');
        this.isConnected = false;
        this.rejectPendingCalls('连接已断开');
      };
    } catch (error) {
      console.error('[MyCallProxy] 连接失败:', error);
    }
  }

  // 代理调用
  proxyCall(api, params, callback) {
    const msgId = this.generateMsgId();
    const deviceId = this.extractDeviceId(this.serverUrl);

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
      type: 'call',
      msgId: msgId,
      deviceId: deviceId,
      timestamp: Date.now(),
      api: api,
      params: params || {}
    };

    try {
      this.ws.send(JSON.stringify(message));
      console.log(`[MyCallProxy] 📤 发送: ${api} (msgId: ${msgId})`);
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

  // 从服务器URL提取设备ID
  extractDeviceId(url) {
    const match = url.match(/deviceId=([^&]+)/);
    return match ? match[1] : null;
  }

  // 销毁代理
  destroy() {
    this.isConnected = false;
    if (this.ws) {
      this.ws.close();
    }
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
