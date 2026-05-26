class MyCallProxy {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.pendingCalls = new Map(); // msgId → { callback, timestamp }
    this.isConnected = false;
    this.originalMyCall = null;
    this.msgIdCounter = 0;
    this.deviceId = null;
    this.isPolling = false;
    this.retryCount = 0;
    this.lastActivity = Date.now();
  }

  init() {
    if (typeof my === 'undefined' || typeof my.call !== 'function') {
      console.error('my.call 不存在，无法初始化代理');
      return false;
    }

    this.originalMyCall = my.call;
    this.deviceId = this.extractDeviceId(this.serverUrl);

    const self = this;
    my.call = function(api, params, callback) {
      console.log("my.call", api);
      if (self.isConnected) {
        self.proxyCall(api, params, callback);
      } else {
        console.warn('[代理未连接] 使用原始 my.call');
        self.originalMyCall.call(this, api, params, callback);
      }
    };

    this.registerDevice();
    console.log('[MyCallProxy] ✅ my.call 代理已初始化（HTTP 模式）');
    return true;
  }

  registerDevice() {
    my.request({
      url: `${this.serverUrl}/api/proxy/register`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      data: JSON.stringify({
        deviceId: this.deviceId,
        deviceInfo: {}
      }),
      success: () => {
        console.log('[MyCallProxy] ✅ 设备注册成功');
        this.isConnected = true;
      },
      fail: (err) => {
        console.error('[MyCallProxy] 注册失败:', err);
      }
    });
  }

  proxyCall(api, params, callback) {
    const msgId = this.generateMsgId();

    this.pendingCalls.set(msgId, {
      callback: callback || (() => {}),
      timestamp: Date.now()
    });

    this.lastActivity = Date.now();

    my.request({
      url: `${this.serverUrl}/api/proxy/call`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      data: JSON.stringify({
        deviceId: this.deviceId,
        msgId: msgId,
        api: api,
        params: params || {},
        timestamp: Date.now()
      }),
      success: () => {
        console.log(`[MyCallProxy] 📤 发送: ${api} (msgId: ${msgId})`);

        if (!this.isPolling) {
          this.startPolling();
        }
      },
      fail: (err) => {
        console.error('[MyCallProxy] 发送失败:', err);
        this.pendingCalls.delete(msgId);
        this.fallbackToOriginal(api, params, callback);
      }
    });
  }

  startPolling() {
    if (this.isPolling) {
      console.log('[MyCallProxy] 轮询已在运行中');
      return;
    }

    this.isPolling = true;
    console.log('[MyCallProxy] 🔍 开始长轮询');

    const poll = () => {
      my.request({
        url: `${this.serverUrl}/api/proxy/response?deviceId=${this.deviceId}`,
        method: 'GET',
        success: (res) => {
          this.retryCount = 0;

          if (res.data.type === 'response') {
            this.handleMessage(res.data);
            this.lastActivity = Date.now();
          }

          if (this.shouldStopPolling()) {
            console.log('[MyCallProxy] ⏸ 停止长轮询（空闲）');
            this.isPolling = false;
            return;
          }

          setTimeout(poll, 100);
        },
        fail: (err) => {
          console.error('[MyCallProxy] 轮询失败:', err);
          this.isConnected = false;

          const delay = this.getRetryDelay();
          setTimeout(poll, delay);
        }
      });
    };

    poll();
  }

  shouldStopPolling() {
    if (this.pendingCalls.size > 0) {
      return false;
    }

    const idleTime = Date.now() - this.lastActivity;
    return idleTime > 30000;
  }

  getRetryDelay() {
    const delay = Math.min(1000 * Math.pow(2, this.retryCount), 10000);
    this.retryCount++;
    console.log(`[MyCallProxy] 重试延迟: ${delay}ms (第 ${this.retryCount} 次)`);
    return delay;
  }

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

  fallbackToOriginal(api, params, callback) {
    console.warn('[MyCallProxy] 回退到原始 my.call');
    if (this.originalMyCall) {
      this.originalMyCall.call(this, api, params, callback);
    }
  }

  generateMsgId() {
    return 'msg_' + Date.now() + '_' + (++this.msgIdCounter);
  }

  extractDeviceId(url) {
    const match = url.match(/deviceId=([^&]+)/);
    return match ? match[1] : null;
  }

  destroy() {
    this.isConnected = false;
    this.isPolling = false;
    if (this.originalMyCall) {
      my.call = this.originalMyCall;
    }
    this.pendingCalls.clear();
    console.log('[MyCallProxy] 🔌 my.call 代理已销毁');
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      isPolling: this.isPolling,
      pending_calls: this.pendingCalls.size,
      serverUrl: this.serverUrl
    };
  }
}

// 支持 CommonJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MyCallProxy };
}

// 支持 CommonJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MyCallProxy };
}
