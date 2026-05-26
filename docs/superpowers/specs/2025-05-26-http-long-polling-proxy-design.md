# mPaaS JSAPI 代理 - HTTP 长轮询架构设计

**日期**: 2025-05-26
**作者**: Sisyphus
**状态**: 设计阶段

## 1. 概述

### 1.1 背景

mPaaS 开发者工具（模拟器）对 WebSocket 的支持存在限制，导致模拟器客户端无法通过 WebSocket 连接到代理服务器。为了解决这个问题，需要为模拟器客户端提供基于 HTTP 的通信方式。

### 1.2 目标

- ✅ 支持模拟器通过 HTTP 长轮询调用真机 JSAPI
- ✅ 保持真机小程序的 WebSocket 连接不变
- ✅ 最小化代码改动，保持架构简洁
- ✅ 提供良好的开发调试体验

### 1.3 约束

- 仅用于开发调试环境，无需生产级安全机制
- 保持现有真机连接功能不变
- 使用 mPaaS/支付宝小程序支持的 API（my.request）

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────────┐                    ┌──────────────────┐
│   真机小程序     │                    │   模拟器客户端    │
│  (WebSocket)    │                    │  (HTTP 长轮询)    │
└────────┬────────┘                    └────────┬─────────┘
         │                                     │
         │ WebSocket                            │ HTTP 请求
         │                                      │
         ▼                                      ▼
┌─────────────────────────────────────────────────────┐
│              mPaaS JSAPI 代理服务器                    │
│  ┌────────────────┐              ┌────────────────┐  │
│  │  WebSocket     │              │  HTTP API      │  │
│  │  Handler       │◄────────────►│  Handler       │  │
│  └────────┬───────┘              └────────┬────────┘  │
│           │                               │           │
│           └───────────┬───────────────────┘           │
│                       ▼                               │
│              ┌────────────────┐                       │
│              │ 响应队列管理    │                       │
│              │ (内存 Map)     │                       │
│              └────────────────┘                       │
└─────────────────────────────────────────────────────┘
```

### 2.2 技术选型

| 组件 | 技术选择 | 理由 |
|------|---------|------|
| HTTP 服务器 | Express.js | 轻量级，与现有 Node.js 服务器集成简单 |
| HTTP 客户端 | my.request | mPaaS/支付宝小程序原生支持 |
| 长轮询实现 | 原生 HTTP + setTimeout | 简单可靠，无需额外依赖 |
| 响应队列 | 内存 Map 结构 | 快速访问，开发环境够用 |

### 2.3 混合架构优势

1. **最小改动**：真机代码保持不变，WebSocket 连接已经稳定工作
2. **协议适配**：每种客户端使用最适合的协议
3. **易于调试**：两种协议可以独立测试和排错
4. **向后兼容**：不影响现有真机连接功能

## 3. API 设计

### 3.1 接口规范

#### 3.1.1 发起 API 调用

**请求**
```http
POST /api/proxy/call
Content-Type: application/json

{
  "deviceId": "device_1716732000000_abc123def",
  "msgId": "msg_1700000000000_1",
  "api": "xlGetAppInfo",
  "params": {},
  "timestamp": 1700000000000
}
```

**响应**
```json
{
  "success": true,
  "message": "调用已转发到真机"
}
```

**错误响应**
```json
{
  "error": "DEVICE_NOT_REGISTERED",
  "message": "设备未注册，请先使用 WebSocket 注册"
}
```

#### 3.1.2 获取响应（长轮询）

**请求**
```http
GET /api/proxy/response?deviceId=device_1716732000000_abc123def
```

**响应（有数据）**
```json
{
  "type": "response",
  "msgId": "msg_1700000000000_1",
  "result": {
    "appInfo": {...}
  },
  "timestamp": 1700000001000
}
```

**响应（超时）**
```json
{
  "type": "timeout"
}
```

**超时时间**: 30 秒

#### 3.1.3 设备注册

**请求**
```http
POST /api/proxy/register
Content-Type: application/json

{
  "deviceId": "device_1716732000000_abc123def",
  "deviceInfo": {
    "model": "iPhone 12",
    "system": "iOS 14.0"
  }
}
```

**响应**
```json
{
  "success": true,
  "message": "注册成功"
}
```

### 3.2 长轮询策略

- **超时时间**: 30 秒
- **重试策略**: 指数退避
  - 初始延迟: 1 秒
  - 退避序列: 1s → 2s → 4s → 8s → 10s（最大）
  - 成功获取响应后重置为 1 秒
- **并发控制**: 每个设备最多 1 个活跃的长轮询连接
- **轮询时机**: 按需启动（重要！）
  - **启动条件**: 发起 API 调用后才开始轮询
  - **停止条件**: 
    - 所有待处理请求完成 且 空闲超过 30 秒
  - **优势**: 节省资源，避免无效轮询

## 4. 数据流设计

### 4.1 模拟器调用流程

```
1. 模拟器代码调用
   my.call('xlGetAppInfo', {}, callback)

2. 劫持 my.call
   → 检查连接状态
   → 如果已连接，使用 HTTP 代理

3. 发送 HTTP POST
   POST /api/proxy/call
   {deviceId, msgId, api, params}

4. 服务器处理
   → 验证设备已注册
   → 通过 WebSocket 转发到真机
   → 返回成功响应

5. 真机执行 API
   → my.call(api, params)
   → 执行完成
   → 通过 WebSocket 返回结果

6. 服务器接收结果
   → 存入响应队列
   → responseQueue.set(deviceId, response)

7. 模拟器长轮询
   GET /api/proxy/response?deviceId=xxx
   → 服务器检查队列
   → 有数据：立即返回
   → 无数据：等待最多 30 秒

8. 执行回调
   callback(result)
```

### 4.2 错误处理流程

```
错误场景                     服务器响应              客户端处理
────────────────────────────────────────────────────────
设备未注册                   400 DEVICE_NOT_REGISTERED  回退原始 my.call
真机离线                     503 DEVICE_OFFLINE         回退原始 my.call
长轮询超时                   200 {type: "timeout"}      继续轮询
网络错误                     N/A                      指数退避重试
服务器重启                   队列清空                  重新注册
```

## 5. 实现细节

### 5.1 服务器端

#### 5.1.1 新增文件

**`proxy_server/src/http-handler.js`**
```javascript
const express = require('express');
const { Utils } = require('./utils');

class HttpHandler {
  constructor(deviceManager, responseQueue) {
    this.deviceManager = deviceManager;
    this.responseQueue = responseQueue;
    this.router = express.Router();
    this.setupRoutes();
  }

  setupRoutes() {
    this.router.post('/call', express.json(), this.handleCall.bind(this));
    this.router.get('/response', this.handlePolling.bind(this));
    this.router.post('/register', express.json(), this.handleRegister.bind(this));
  }

  // 处理 API 调用请求
  async handleCall(req, res) {
    const { deviceId, msgId, api, params } = req.body;

    if (!deviceId || !msgId || !api) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: '缺少必要参数'
      });
    }

    const device = this.deviceManager.getDevice(deviceId);
    if (!device || !device.miniappWS) {
      return res.status(503).json({
        error: 'DEVICE_OFFLINE',
        message: '真机小程序未连接'
      });
    }

    // 通过 WebSocket 转发到真机
    try {
      device.miniappWS.send(JSON.stringify({
        type: 'call',
        msgId,
        deviceId,
        api,
        params: params || {},
        timestamp: Date.now()
      }));

      Utils.log(`[HTTP] 转发调用: ${api} → ${deviceId}`, 'info');
      res.json({ success: true, message: '调用已转发' });
    } catch (error) {
      res.status(500).json({
        error: 'SEND_FAILED',
        message: error.message
      });
    }
  }

  // 处理长轮询请求
  async handlePolling(req, res) {
    const { deviceId } = req.query;

    if (!deviceId) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: '缺少 deviceId 参数'
      });
    }

    try {
      const response = await this.responseQueue.poll(deviceId, 30000);
      if (response) {
        res.json(response);
      } else {
        res.json({ type: 'timeout' });
      }
    } catch (error) {
      res.status(500).json({
        error: 'POLL_FAILED',
        message: error.message
      });
    }
  }

  // 处理设备注册
  async handleRegister(req, res) {
    const { deviceId, deviceInfo } = req.body;

    if (!deviceId) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: '缺少 deviceId'
      });
    }

    // 标记设备为 HTTP 客户端
    this.deviceManager.registerHttpDevice(deviceId, deviceInfo);

    Utils.log(`[HTTP] 设备注册: ${deviceId}`, 'info');
    res.json({ success: true, message: '注册成功' });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = { HttpHandler };
```

**`proxy_server/src/response-queue.js`**
```javascript
class ResponseQueue {
  constructor() {
    this.queues = new Map(); // deviceId → Array of responses
  }

  // 推送响应到队列
  push(deviceId, response) {
    if (!this.queues.has(deviceId)) {
      this.queues.set(deviceId, []);
    }
    this.queues.get(deviceId).push(response);
  }

  // 长轮询等待响应
  poll(deviceId, timeout = 30000) {
    return new Promise((resolve) => {
      // 检查是否已有响应
      if (this.hasResponse(deviceId)) {
        resolve(this.dequeue(deviceId));
        return;
      }

      // 等待新响应
      const timer = setTimeout(() => {
        cleanup();
        resolve(null); // 超时
      }, timeout);

      const cleanup = () => {
        clearTimeout(timer);
      };
    });
  }

  // 检查是否有响应
  hasResponse(deviceId) {
    const queue = this.queues.get(deviceId);
    return queue && queue.length > 0;
  }

  // 从队列取出响应
  dequeue(deviceId) {
    const queue = this.queues.get(deviceId);
    if (queue && queue.length > 0) {
      return queue.shift();
    }
    return null;
  }

  // 清理设备队列
  clear(deviceId) {
    this.queues.delete(deviceId);
  }
}

module.exports = { ResponseQueue };
```

#### 5.1.2 修改文件

**`proxy_server/package.json`**
```json
{
  "dependencies": {
    "ws": "^8.14.0",
    "express": "^4.18.2"
  }
}
```

**`proxy_server/index.js`**
```javascript
const express = require('express');
const { ProxyServer } = require('./src/server');
const { HttpHandler } = require('./src/http-handler');
const { ResponseQueue } = require('./src/response-queue');
const config = require('./config');

const app = express();
app.use(express.json());

// 初始化组件
const proxyServer = new ProxyServer(config);
const responseQueue = new ResponseQueue();
const httpHandler = new HttpHandler(proxyServer.deviceManager, responseQueue);

// 注册 HTTP 路由
app.use('/api/proxy', httpHandler.getRouter());

// 启动 WebSocket 服务器
proxyServer.start();

// 启动 HTTP 服务器
const httpServer = app.listen(config.port, () => {
  console.log(`HTTP 服务器已启动，端口: ${config.port}`);
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  proxyServer.stop();
  httpServer.close();
  process.exit(0);
});
```

### 5.2 客户端

**`my-call-proxy.js` 修改**

主要变更：
1. 移除 WebSocket 连接代码
2. 使用 my.request 发送 HTTP 请求
3. 实现按需长轮询（发送请求后才开始轮询）
4. 添加智能停止逻辑（空闲30秒停止轮询）
5. 添加指数退避重试机制

```javascript
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

  // 初始化代理
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

    // 注册设备
    this.registerDevice();
    console.log('[MyCallProxy] ✅ my.call 代理已初始化（HTTP 模式）');
    return true;
  }

  // 注册设备到服务器
  registerDevice() {
    my.request({
      url: `${this.serverUrl}/api/proxy/register`,
      method: 'POST',
      data: {
        deviceId: this.deviceId,
        deviceInfo: {}
      },
      success: () => {
        console.log('[MyCallProxy] ✅ 设备注册成功');
        this.isConnected = true;
        // 注意：注册成功后不立即开始轮询，等待第一个 API 调用
      },
      fail: (err) => {
        console.error('[MyCallProxy] 注册失败:', err);
      }
    });
  }

  // 代理调用（HTTP 方式）
  proxyCall(api, params, callback) {
    const msgId = this.generateMsgId();

    // 存储回调
    this.pendingCalls.set(msgId, {
      callback: callback || (() => {}),
      timestamp: Date.now()
    });

    // 更新活动时间
    this.lastActivity = Date.now();

    // 发送 HTTP POST
    my.request({
      url: `${this.serverUrl}/api/proxy/call`,
      method: 'POST',
      data: {
        deviceId: this.deviceId,
        msgId: msgId,
        api: api,
        params: params || {},
        timestamp: Date.now()
      },
      success: () => {
        console.log(`[MyCallProxy] 📤 发送: ${api} (msgId: ${msgId})`);
        
        // 开始轮询（如果还没开始）
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

  // 长轮询获取响应（按需启动）
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
          this.retryCount = 0; // 重置重试计数

          if (res.data.type === 'response') {
            this.handleMessage(res.data);
            this.lastActivity = Date.now();
          }

          // 检查是否应该停止轮询
          if (this.shouldStopPolling()) {
            console.log('[MyCallProxy] ⏸ 停止长轮询（空闲）');
            this.isPolling = false;
            return;
          }

          // 继续轮询
          setTimeout(poll, 100);
        },
        fail: (err) => {
          console.error('[MyCallProxy] 轮询失败:', err);
          this.isConnected = false;

          // 指数退避重试
          const delay = this.getRetryDelay();
          setTimeout(poll, delay);
        }
      });
    };

    poll();
  }

  // 判断是否应该停止轮询
  shouldStopPolling() {
    // 如果还有待处理的请求，继续轮询
    if (this.pendingCalls.size > 0) {
      return false;
    }

    // 如果空闲超过30秒，停止轮询
    const idleTime = Date.now() - this.lastActivity;
    return idleTime > 30000;
  }

  // 指数退避
  getRetryDelay() {
    const delay = Math.min(1000 * Math.pow(2, this.retryCount), 10000);
    this.retryCount++;
    console.log(`[MyCallProxy] 重试延迟: ${delay}ms (第 ${this.retryCount} 次)`);
    return delay;
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
    }
  }

  // 回退到原始 my.call
  fallbackToOriginal(api, params, callback) {
    console.warn('[MyCallProxy] 回退到原始 my.call');
    if (this.originalMyCall) {
      this.originalMyCall.call(this, api, params, callback);
    }
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
    this.isPolling = false;
    if (this.originalMyCall) {
      my.call = this.originalMyCall;
    }
    this.pendingCalls.clear();
    console.log('[MyCallProxy] 🔌 my.call 代理已销毁');
  }

  // 获取连接状态
  getStatus() {
    return {
      isConnected: this.isConnected,
      isPolling: this.isPolling,
      pending_calls: this.pendingCalls.size,
      serverUrl: this.serverUrl
    };
  }
}
```

## 6. 测试计划

### 6.1 单元测试

**服务器端**
- ✅ HTTP API 端点测试
- ✅ 响应队列操作测试
- ✅ 错误处理测试

**客户端**
- ✅ HTTP 请求测试
- ✅ 长轮询逻辑测试
- ✅ 重试机制测试

### 6.2 集成测试

**场景 1：正常调用流程**
```
1. 模拟器注册设备
2. 模拟器发起 API 调用
3. 真机执行并返回结果
4. 模拟器接收响应
5. 验证回调执行正确
```

**场景 2：设备离线**
```
1. 模拟器发起 API 调用
2. 真机未连接
3. 验证回退到原始 my.call
```

**场景 3：长轮询超时**
```
1. 模拟器开始轮询
2. 30秒内无响应
3. 验证返回 timeout
4. 验证继续轮询
```

**场景 4：网络恢复**
```
1. 模拟器轮询失败
2. 指数退避重试
3. 网络恢复
4. 验证正常轮询恢复
```

### 6.3 性能测试

- 并发调用：10 个同时调用
- 长时间运行：持续运行 1 小时
- 内存泄漏检查

## 7. 部署说明

### 7.1 环境要求

- Node.js >= 14.0.0
- npm 或 yarn
- 真机安装支付宝客户端

### 7.2 安装步骤

```bash
# 1. 安装依赖
cd proxy_server
npm install

# 2. 启动服务器
npm start

# 3. 真机连接
在真机小程序中输入服务器地址并连接

# 4. 模拟器使用
在 app.js 中配置设备ID后使用
```

### 7.3 配置说明

**服务器配置** (`proxy_server/config.js`)
```javascript
module.exports = {
  port: 3000,
  wsPath: '/ws',
  heartbeatInterval: 30000
};
```

**客户端配置** (`app.js`)
```javascript
const proxy = new MyCallProxy('http://192.168.0.12:3000?deviceId=device_xxx');
proxy.init();
```

## 8. 风险和限制

### 8.1 风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| HTTP 长轮询延迟比 WebSocket 高 | 实时性稍差 | 30秒超时可接受 |
| 服务器需要维护两套协议 | 复杂度增加 | 代码已解耦 |
| 响应队列占用内存 | 内存泄漏风险 | 5分钟超时清理 |

### 8.2 限制

- 仅适用于开发调试环境
- 不适合生产环境使用
- 需要真机和服务器在同一网络

## 9. 后续优化

### 9.1 短期优化

- [ ] 添加请求日志记录
- [ ] 优化长轮询性能
- [ ] 添加更详细的错误信息

### 9.2 长期优化

- [ ] 支持 WebSocket 自动降级到 HTTP
- [ ] 添加性能监控
- [ ] 支持多设备管理

## 10. 总结

本设计通过引入 HTTP 长轮询方式，解决了 mPaaS 开发者工具（模拟器）对 WebSocket 支持有限的问题。采用混合架构，保持了真机 WebSocket 连接的稳定性和实时性，同时为模拟器提供了可行的替代方案。

设计遵循简单性原则，使用成熟的技术栈（Express.js、my.request），实现复杂度可控，易于维护和扩展。
