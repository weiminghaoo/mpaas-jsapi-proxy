# mPaaS JSAPI 代理系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 mPaaS 小程序的 my.call 代理系统，使模拟器中的 my.call 调用能够转发到真机执行

**Architecture:** WebSocket 长连接中转架构，包含三个组件：代理服务器（Node.js）、代理小程序（mPaaS）、模拟器客户端（JavaScript）。消息使用 JSON 格式，通过 msgId 匹配请求和响应。

**Tech Stack:** Node.js + ws 库、mPaaS 小程序框架、纯 JavaScript

---

## 文件结构

### 代理服务器
```
proxy_server/
├── package.json                    # 依赖配置
├── index.js                        # 主入口，启动服务器
├── config.js                       # 端口等配置
└── src/
    ├── server.js                   # WebSocket 服务器核心
    ├── device-manager.js           # 设备连接管理（deviceId → 连接映射）
    ├── message-router.js           # 消息路由处理
    └── utils.js                    # 工具函数（获取本地IP、日志格式化）
```

### 代理小程序
```
utils/
└── storage.js                      # 设备ID生成和持久化

pages/proxy/
├── proxy.js                        # 代理页面逻辑（WebSocket连接、消息处理）
├── proxy.json                      # 页面配置
├── proxy.axml                      # 页面模板（界面UI）
└── proxy.acss                      # 页面样式
```

### 模拟器客户端
```
my-call-proxy.js                    # 代理客户端（my.call劫持、WebSocket通信）
```

---

## Task 1: 初始化代理服务器项目

**Files:**
- Create: `proxy_server/package.json`
- Create: `proxy_server/config.js`
- Create: `proxy_server/index.js`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "mpaas-jsapi-proxy-server",
  "version": "1.0.0",
  "description": "mPaaS JSAPI 代理服务器",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node index.js"
  },
  "keywords": ["mpaas", "proxy", "websocket"],
  "author": "",
  "license": "MIT",
  "dependencies": {
    "ws": "^8.14.0"
  }
}
```

- [ ] **Step 2: 创建 config.js**

```javascript
module.exports = {
  port: 3000,
  wsPath: '/ws',
  heartbeatInterval: 30000 // 30秒
};
```

- [ ] **Step 3: 创建 index.js 主入口**

```javascript
const { ProxyServer } = require('./src/server');
const config = require('./config');

const server = new ProxyServer(config);

// 启动服务器
server.start();

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  server.stop();
  process.exit(0);
});
```

- [ ] **Step 4: 提交**

```bash
git add proxy_server/
git commit -m "feat: 初始化代理服务器项目结构"
```

---

## Task 2: 实现工具函数模块

**Files:**
- Create: `proxy_server/src/utils.js`

- [ ] **Step 1: 创建 utils.js**

```javascript
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
```

- [ ] **Step 2: 提交**

```bash
git add proxy_server/src/utils.js
git commit -m "feat: 添加工具函数模块（IP获取、日志）"
```

---

## Task 3: 实现设备管理器

**Files:**
- Create: `proxy_server/src/device-manager.js`

- [ ] **Step 1: 创建 device-manager.js**

```javascript
const { Utils } = require('./utils');

class DeviceManager {
  constructor() {
    // deviceId → { miniappWS, simulatorWS, deviceInfo, lastHeartbeat }
    this.devices = new Map();
  }

  // 注册设备（小程序连接）
  registerDevice(deviceId, miniappWS, deviceInfo) {
    // 如果设备已存在，更新连接
    if (this.devices.has(deviceId)) {
      const existing = this.devices.get(deviceId);
      existing.miniappWS = miniappWS;
      existing.deviceInfo = deviceInfo;
      existing.lastHeartbeat = Date.now();
      Utils.log(`设备更新连接: ${deviceId}`, 'info');
    } else {
      this.devices.set(deviceId, {
        miniappWS,
        simulatorWS: null,
        deviceInfo,
        lastHeartbeat: Date.now()
      });
      Utils.log(`设备注册成功: ${deviceId}`, 'success');
    }
  }

  // 连接模拟器
  connectSimulator(deviceId, simulatorWS) {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`设备未注册: ${deviceId}`);
    }
    device.simulatorWS = simulatorWS;
    Utils.log(`模拟器已连接到设备: ${deviceId}`, 'success');
  }

  // 断开连接
  disconnect(ws) {
    for (const [deviceId, device] of this.devices) {
      if (device.miniappWS === ws || device.simulatorWS === ws) {
        this.devices.delete(deviceId);
        Utils.log(`设备断开连接: ${deviceId}`, 'warn');
        return true;
      }
    }
    return false;
  }

  // 获取设备信息
  getDevice(deviceId) {
    return this.devices.get(deviceId);
  }

  // 检查设备是否就绪（小程序和模拟器都已连接）
  isDeviceReady(deviceId) {
    const device = this.devices.get(deviceId);
    return device && device.miniappWS && device.simulatorWS;
  }

  // 更新心跳时间
  updateHeartbeat(deviceId) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastHeartbeat = Date.now();
    }
  }

  // 获取所有设备状态
  getAllDevices() {
    return Array.from(this.devices.entries()).map(([id, device]) => ({
      deviceId: id,
      hasMiniapp: !!device.miniappWS,
      hasSimulator: !!device.simulatorWS,
      lastHeartbeat: device.lastHeartbeat
    }));
  }
}

module.exports = { DeviceManager };
```

- [ ] **Step 2: 提交**

```bash
git add proxy_server/src/device-manager.js
git commit -m "feat: 实现设备管理器"
```

---

## Task 4: 实现消息路由器

**Files:**
- Create: `proxy_server/src/message-router.js`

- [ ] **Step 1: 创建 message-router.js**

```javascript
const { Utils } = require('./utils');

class MessageRouter {
  constructor(deviceManager) {
    this.deviceManager = deviceManager;
  }

  // 处理接收到的消息
  handleMessage(message, ws) {
    const { type, msgId, deviceId } = message;

    if (!type || !msgId) {
      this.sendError(ws, msgId, 'INVALID_MESSAGE', '消息格式错误');
      return;
    }

    switch (type) {
      case 'register':
        this.handleRegister(message, ws);
        break;
      case 'call':
        this.handleCall(message, ws);
        break;
      case 'response':
        this.handleResponse(message, ws);
        break;
      case 'heartbeat':
        this.handleHeartbeat(message);
        break;
      default:
        this.sendError(ws, msgId, 'UNKNOWN_MESSAGE_TYPE', `未知消息类型: ${type}`);
    }
  }

  // 处理设备注册
  handleRegister(message, ws) {
    const { msgId, deviceId, deviceInfo } = message;

    if (!deviceId) {
      this.sendError(ws, msgId, 'INVALID_DEVICE_ID', '设备ID不能为空');
      return;
    }

    this.deviceManager.registerDevice(deviceId, ws, deviceInfo);

    // 发送注册成功响应
    ws.send(JSON.stringify({
      type: 'register',
      msgId: msgId,
      deviceId: deviceId,
      success: true,
      timestamp: Date.now()
    }));
  }

  // 处理 API 调用（来自模拟器）
  handleCall(message, ws) {
    const { msgId, deviceId, api, params } = message;

    if (!deviceId) {
      this.sendError(ws, msgId, 'INVALID_DEVICE_ID', '设备ID不能为空');
      return;
    }

    const device = this.deviceManager.getDevice(deviceId);
    if (!device || !device.miniappWS) {
      this.sendError(ws, msgId, 'DEVICE_OFFLINE', '代理小程序未连接');
      return;
    }

    // 转发到小程序
    try {
      device.miniappWS.send(JSON.stringify(message));
      Utils.log(`转发调用: ${api} → ${deviceId}`, 'info');
    } catch (error) {
      this.sendError(ws, msgId, 'SEND_FAILED', `发送失败: ${error.message}`);
    }
  }

  // 处理响应消息（来自小程序）
  handleResponse(message, ws) {
    const { deviceId } = message;

    const device = this.deviceManager.getDevice(deviceId);
    if (!device || !device.simulatorWS) {
      Utils.log(`无模拟器连接，丢弃响应: ${deviceId}`, 'warn');
      return;
    }

    // 转发到模拟器
    try {
      device.simulatorWS.send(JSON.stringify(message));
      Utils.log(`转发响应 → ${deviceId}`, 'info');
    } catch (error) {
      Utils.log(`转发响应失败: ${error.message}`, 'error');
    }
  }

  // 处理心跳
  handleHeartbeat(message) {
    const { deviceId } = message;
    this.deviceManager.updateHeartbeat(deviceId);
  }

  // 发送错误消息
  sendError(ws, msgId, code, message) {
    if (ws && ws.readyState === 1) { // WebSocket.OPEN
      ws.send(JSON.stringify({
        type: 'error',
        msgId: msgId,
        timestamp: Date.now(),
        error: {
          code: code,
          message: message
        }
      }));
    }
  }
}

module.exports = { MessageRouter };
```

- [ ] **Step 2: 提交**

```bash
git add proxy_server/src/message-router.js
git commit -m "feat: 实现消息路由器"
```

---

## Task 5: 实现服务器核心

**Files:**
- Create: `proxy_server/src/server.js`

- [ ] **Step 1: 创建 server.js**

```javascript
const WebSocket = require('ws');
const { DeviceManager } = require('./device-manager');
const { MessageRouter } = require('./message-router');
const { Utils } = require('./utils');
const config = require('../config');

class ProxyServer {
  constructor(customConfig) {
    this.config = { ...config, ...customConfig };
    this.deviceManager = new DeviceManager();
    this.messageRouter = new MessageRouter(this.deviceManager);
    this.wss = null;
  }

  // 启动服务器
  start() {
    // 创建 WebSocket 服务器
    this.wss = new WebSocket.Server({
      port: this.config.port,
      path: this.config.wsPath
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (error) => {
      Utils.log(`服务器错误: ${error.message}`, 'error');
    });

    // 启动心跳检测
    this.startHeartbeatCheck();

    Utils.log(`代理服务器启动成功`, 'success');
    Utils.log(`监听端口: ${this.config.port}`, 'info');
    this.displayConnectionInfo();
  }

  // 处理新连接
  handleConnection(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const clientType = url.searchParams.get('type'); // 'miniapp' or 'simulator'

    Utils.log(`新连接: ${clientType || 'unknown'}`, 'info');

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        this.messageRouter.handleMessage(message, ws);
      } catch (error) {
        Utils.log(`消息解析失败: ${error.message}`, 'error');
      }
    });

    ws.on('close', () => {
      this.deviceManager.disconnect(ws);
    });

    ws.on('error', (error) => {
      Utils.log(`WebSocket错误: ${error.message}`, 'error');
    });
  }

  // 显示连接信息
  displayConnectionInfo() {
    const localIP = Utils.getLocalIP();
    const serverUrl = Utils.formatServerUrl(localIP, this.config.port, this.config.wsPath);

    console.log(`
╔════════════════════════════════════════════════════════════╗
║            mPaaS JSAPI 代理服务器                          ║
╠════════════════════════════════════════════════════════════╣
║  请在代理小程序中输入以下地址进行注册                      ║
║                                                            ║
║  ${serverUrl.padEnd(58)}║
║                                                            ║
║  参数: ?type=miniapp                                       ║
║                                                            ║
║  完整示例:                                                  ║
║  ${serverUrl + '?type=miniapp'.padEnd(54)}║
╚════════════════════════════════════════════════════════════╝
    `);
  }

  // 启动心跳检测
  startHeartbeatCheck() {
    setInterval(() => {
      const now = Date.now();
      const timeout = this.config.heartbeatInterval * 2;

      for (const [deviceId, device] of this.deviceManager.devices) {
        if (now - device.lastHeartbeat > timeout) {
          Utils.log(`设备心跳超时: ${deviceId}`, 'warn');
          if (device.miniappWS) {
            device.miniappWS.close();
          }
          if (device.simulatorWS) {
            device.simulatorWS.close();
          }
          this.deviceManager.devices.delete(deviceId);
        }
      }
    }, this.config.heartbeatInterval);
  }

  // 停止服务器
  stop() {
    if (this.wss) {
      this.wss.close();
      Utils.log('服务器已关闭', 'info');
    }
  }
}

module.exports = { ProxyServer };
```

- [ ] **Step 2: 提交**

```bash
git add proxy_server/src/server.js
git commit -m "feat: 实现WebSocket服务器核心"
```

---

## Task 6: 测试代理服务器

**Files:**
- Create: `proxy_server/test/manual-test.js`

- [ ] **Step 1: 创建测试脚本**

```javascript
// 手动测试脚本 - 模拟小程序连接
const WebSocket = require('ws');

const SERVER_URL = 'ws://localhost:3000/ws?type=miniapp';
const TEST_DEVICE_ID = 'device_test_001';

console.log('连接到服务器:', SERVER_URL);

const ws = new WebSocket(SERVER_URL);

ws.on('open', () => {
  console.log('✅ 已连接');

  // 发送注册消息
  const registerMsg = {
    type: 'register',
    msgId: 'msg_register_' + Date.now(),
    deviceId: TEST_DEVICE_ID,
    timestamp: Date.now(),
    deviceInfo: {
      model: 'Test Device',
      system: 'Test OS 1.0'
    }
  };

  ws.send(JSON.stringify(registerMsg));
  console.log('📤 发送注册消息');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log('📥 收到消息:', msg);
});

ws.on('close', () => {
  console.log('❌ 连接已关闭');
});

ws.on('error', (error) => {
  console.error('❌ 错误:', error.message);
});
```

- [ ] **Step 2: 安装依赖并启动服务器**

```bash
cd proxy_server
npm install
npm start
```

预期输出：
```
[时间] ✅ 代理服务器启动成功
[时间] ℹ️ 监听端口: 3000
╔════════════════════════════════════════════════════════════╗
║            mPaaS JSAPI 代理服务器                          ║
╚════════════════════════════════════════════════════════════╝
```

- [ ] **Step 3: 在另一个终端运行测试**

```bash
cd proxy_server
node test/manual-test.js
```

预期输出：
```
连接到服务器: ws://localhost:3000/ws?type=miniapp
✅ 已连接
📤 发送注册消息
📥 收到消息: { type: 'register', success: true, ... }
```

- [ ] **Step 4: 提交**

```bash
git add proxy_server/test/
git commit -m "test: 添加代理服务器手动测试脚本"
```

---

## Task 7: 实现小程序工具模块

**Files:**
- Create: `utils/storage.js`

- [ ] **Step 1: 创建 storage.js**

```javascript
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
```

- [ ] **Step 2: 提交**

```bash
git add utils/storage.js
git commit -m "feat: 实现小程序设备ID管理工具"
```

---

## Task 8: 实现代理小程序页面

**Files:**
- Create: `pages/proxy/proxy.js`
- Create: `pages/proxy/proxy.json`
- Create: `pages/proxy/proxy.axml`
- Create: `pages/proxy/proxy.acss`

- [ ] **Step 1: 创建 proxy.js**

```javascript
const { Storage } = require('../../utils/storage');

Page({
  data: {
    deviceId: '',
    serverUrl: 'ws://192.168.1.100:3000',
    connectionStatus: '未连接', // 未连接、连接中、已连接、已断开
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

  // 输入服务器地址
  onServerUrlInput(e) {
    this.setData({ serverUrl: e.detail.value });
  },

  // 连接服务器
  connect() {
    const serverUrl = this.data.serverUrl.trim();
    if (!serverUrl) {
      my.showToast({ content: '请输入服务器地址', duration: 2000 });
      return;
    }

    this.setData({ connectionStatus: '连接中', statusClass: 'connecting' });

    // 构建 WebSocket 连接地址
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

    // 监听连接打开
    my.onSocketOpen(() => {
      console.log('WebSocket 连接已打开');
      this.register();
    });

    // 监听消息
    my.onSocketMessage((res) => {
      try {
        const message = JSON.parse(res.data);
        this.handleMessage(message);
      } catch (error) {
        console.error('消息解析失败', error);
      }
    });

    // 监听错误
    my.onSocketError((err) => {
      console.error('WebSocket 错误', err);
      this.setData({ connectionStatus: '连接错误', statusClass: 'error' });
      my.showToast({ content: '连接错误', duration: 2000 });
    });

    // 监听关闭
    my.onSocketClose(() => {
      console.log('WebSocket 连接已关闭');
      this.setData({ connectionStatus: '已断开', statusClass: 'disconnected' });
      this.stopHeartbeat();
    });
  },

  // 注册设备
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

  // 处理消息
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

  // 处理 API 调用
  handleApiCall(message) {
    const { msgId, api, params } = message;

    console.log('执行 API 调用:', api, params);

    my.call(api, params || {}, (result) => {
      console.log('API 返回结果:', result);

      // 发送响应回代理服务器
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

  // 开始心跳
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
    }, 30000); // 30秒
  },

  // 停止心跳
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  },

  // 断开连接
  disconnect() {
    this.stopHeartbeat();
    my.closeSocket();
    this.setData({ connectionStatus: '未连接', statusClass: 'disconnected' });
    my.showToast({ content: '已断开连接', duration: 2000 });
  },

  // 复制设备ID
  copyDeviceId() {
    my.setClipboard({
      text: this.deviceId
    });
    my.showToast({ content: '设备ID已复制', duration: 1500 });
  }
});
```

- [ ] **Step 2: 创建 proxy.json**

```json
{
  "defaultTitle": "JSAPI代理",
  "navigationBarBackgroundColor": "#ffffff",
  "navigationBarTextStyle": "black"
}
```

- [ ] **Step 3: 创建 proxy.axml**

```xml
<view class="container">
  <view class="header">
    <text class="title">mPaaS JSAPI 代理</text>
  </view>

  <view class="card">
    <view class="card-title">设备信息</view>
    <view class="info-row">
      <text class="label">设备ID：</text>
      <text class="value" onTap="copyDeviceId">{{deviceId}}</text>
      <text class="hint">点击复制</text>
    </view>
  </view>

  <view class="card">
    <view class="card-title">连接状态</view>
    <view class="status-row">
      <text class="label">状态：</text>
      <text class="status {{statusClass}}">{{connectionStatus}}</text>
    </view>
  </view>

  <view class="card">
    <view class="card-title">服务器配置</view>
    <view class="input-row">
      <input
        class="server-input"
        placeholder="ws://192.168.1.100:3000"
        value="{{serverUrl}}"
        onInput="onServerUrlInput"
      />
    </view>
    <view class="button-row">
      <button class="btn-primary" onTap="connect">连接</button>
      <button class="btn-secondary" onTap="disconnect">断开</button>
    </view>
  </view>

  <view class="footer">
    <text class="hint-text">连接成功后，在模拟器中使用此设备ID</text>
  </view>
</view>
```

- [ ] **Step 4: 创建 proxy.acss**

```css
.container {
  padding: 20rpx;
  background-color: #f5f5f5;
  min-height: 100vh;
}

.header {
  text-align: center;
  padding: 40rpx 0;
}

.title {
  font-size: 36rpx;
  font-weight: bold;
  color: #333;
}

.card {
  background-color: white;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
}

.card-title {
  font-size: 28rpx;
  font-weight: bold;
  color: #333;
  margin-bottom: 20rpx;
}

.info-row, .status-row {
  display: flex;
  align-items: center;
}

.label {
  font-size: 28rpx;
  color: #666;
  margin-right: 10rpx;
}

.value {
  font-size: 26rpx;
  color: #1890ff;
  flex: 1;
}

.hint {
  font-size: 22rpx;
  color: #999;
}

.status {
  font-size: 28rpx;
  font-weight: bold;
}

.status.connected {
  color: #52c41a;
}

.status.disconnected {
  color: #999;
}

.status.connecting, .status.error {
  color: #faad14;
}

.input-row {
  margin-bottom: 20rpx;
}

.server-input {
  width: 100%;
  padding: 20rpx;
  border: 1px solid #d9d9d9;
  border-radius: 8rpx;
  font-size: 26rpx;
}

.button-row {
  display: flex;
  gap: 20rpx;
}

.btn-primary, .btn-secondary {
  flex: 1;
}

.btn-primary {
  background-color: #1890ff;
  color: white;
}

.btn-secondary {
  background-color: #f5f5f5;
  color: #333;
}

.footer {
  text-align: center;
  padding: 40rpx 0;
}

.hint-text {
  font-size: 24rpx;
  color: #999;
}
```

- [ ] **Step 5: 更新 app.json 添加新页面**

```json
{
  "subPackageBuildType": "shared",
  "pages": [
    "pages/index/index",
    "pages/proxy/proxy"
  ],
  "window": {
    "defaultTitle": "My App"
  }
}
```

- [ ] **Step 6: 提交**

```bash
git add pages/proxy/ utils/storage.js app.json
git commit -m "feat: 实现代理小程序页面"
```

---

## Task 9: 实现模拟器代理客户端

**Files:**
- Create: `my-call-proxy.js`

- [ ] **Step 1: 创建 my-call-proxy.js**

```javascript
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
      pendingCalls: this.pendingCalls.size,
      serverUrl: this.serverUrl
    };
  }
}

// 支持 CommonJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MyCallProxy };
}
```

- [ ] **Step 2: 创建使用示例文件**

```javascript
// example-usage.js
const { MyCallProxy } = require('./my-call-proxy.js');

// 创建代理实例
// 注意: deviceId 参数需要从代理小程序中获取
const proxy = new MyCallProxy('ws://192.168.1.100:3000?deviceId=device_abc123');

// 初始化代理
proxy.init();

// 之后所有 my.call 调用都会自动通过代理转发到真机
my.call('scan', { type: 'qr' }, (result) => {
  console.log('扫码结果:', result);
});

// 检查代理状态
console.log('代理状态:', proxy.getStatus());

// 如需销毁代理
// proxy.destroy();
```

- [ ] **Step 3: 提交**

```bash
git add my-call-proxy.js example-usage.js
git commit -m "feat: 实现模拟器代理客户端"
```

---

## Task 10: 端到端测试

**Files:**
- Create: `test/e2e/README.md`

- [ ] **Step 1: 创建测试说明文档**

```markdown
# 端到端测试指南

## 测试前准备

1. 确保电脑和手机在同一局域网
2. 查看电脑的局域网IP地址

## 测试步骤

### 1. 启动代理服务器

```bash
cd proxy_server
npm install
npm start
```

记录终端显示的服务器地址，例如: `ws://192.168.1.100:3000`

### 2. 启动代理小程序

1. 在开发者工具中打开小程序项目
2. 进入 "JSAPI代理" 页面
3. 输入服务器地址: `ws://192.168.1.100:3000`
4. 点击"连接"按钮
5. 确认显示"已连接"状态
6. 复制设备ID（例如: `device_abc123`）

### 3. 配置模拟器代理客户端

在测试代码中使用获取到的设备ID:

```javascript
const { MyCallProxy } = require('./my-call-proxy.js');

const proxy = new MyCallProxy('ws://192.168.1.100:3000?deviceId=device_abc123');
proxy.init();

// 测试调用
my.call('scan', { type: 'qr' }, (result) => {
  console.log('扫码结果:', result);
});
```

### 4. 验证流程

1. 在模拟器中执行 my.call 调用
2. 观察控制台输出:
   - `[MyCallProxy] 📤 发送: scan (msgId: msg_xxx)`
3. 在真机小程序上应该弹出扫码界面
4. 扫码后，模拟器应该收到结果:
   - `[MyCallProxy] 📥 响应: msg_xxx`
5. 验证回调函数收到的结果正确

### 5. 测试不同API

尝试调用其他API:
- `my.getLocation` - 获取定位
- `my.chooseImage` - 选择图片
- `my.alert` - 显示弹窗

### 6. 测试错误场景

1. 关闭小程序，模拟器应该收到错误提示
2. 断开网络连接，验证错误处理
3. 重启服务器，验证重连行为

## 预期结果

- 所有 my.call 调用都能正确转发到真机
- 真机执行结果能正确返回给模拟器
- 错误场景能正确处理和提示
```

- [ ] **Step 2: 提交**

```bash
git add test/e2e/README.md
git commit -m "docs: 添加端到端测试指南"
```

---

## Task 11: 添加项目文档

**Files:**
- Create: `README.md`

- [ ] **Step 1: 创建 README.md**

```markdown
# mPaaS JSAPI 代理系统

将 mPaaS 小程序模拟器中的 `my.call` 调用转发到真机执行。

## 功能特点

- 🔄 透明代理 - 自动劫持 my.call，无需修改现有代码
- 🚀 实时通信 - 基于 WebSocket 长连接
- 🔒 消息匹配 - 通过 msgId 确保请求响应正确对应
- ⚡ 快速失败 - 连接断开立即返回错误
- 📱 设备管理 - 支持多设备，设备ID持久化

## 系统架构

```
模拟器 ←→ 代理服务器 ←→ 真机小程序
```

## 快速开始

### 1. 启动代理服务器

```bash
cd proxy_server
npm install
npm start
```

### 2. 启动代理小程序

1. 在真机上打开代理小程序
2. 输入服务器地址并连接
3. 复制显示的设备ID

### 3. 配置模拟器客户端

```javascript
const { MyCallProxy } = require('./my-call-proxy.js');

const proxy = new MyCallProxy('ws://服务器地址?deviceId=设备ID');
proxy.init();

// 之后所有 my.call 自动通过代理
my.call('scan', {}, (result) => {
  console.log(result);
});
```

## 目录结构

```
├── proxy_server/          # 代理服务器
│   ├── src/
│   │   ├── server.js      # WebSocket服务器
│   │   ├── device-manager.js
│   │   └── message-router.js
│   └── package.json
├── pages/proxy/           # 代理小程序页面
├── utils/                 # 工具模块
├── my-call-proxy.js       # 模拟器客户端
└── README.md
```

## 详细文档

- [系统设计文档](./docs/superpowers/specs/2025-05-25-mpaas-jsapi-proxy-system-design.md)
- [实施计划](./docs/superpowers/plans/2025-05-25-mpaas-jsapi-proxy-implementation.md)
- [测试指南](./test/e2e/README.md)

## 技术栈

- **代理服务器**: Node.js + ws
- **代理小程序**: mPaaS 小程序框架
- **模拟器客户端**: 纯 JavaScript

## 许可证

MIT
```

- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "docs: 添加项目README文档"
```

---

## Task 12: 最终验证

**Files:**
- No changes

- [ ] **Step 1: 完整流程测试**

1. 清空所有测试数据
2. 按照测试指南进行完整的端到端测试
3. 验证所有功能正常工作
4. 检查错误处理是否正确
5. 确认代码无语法错误

- [ ] **Step 2: 代码审查**

检查清单:
- [ ] 所有文件已提交
- [ ] 无TODO或未完成的代码
- [ ] 错误处理完整
- [ ] 日志输出清晰
- [ ] 代码格式一致

- [ ] **Step 3: 创建发布标签**

```bash
git tag -a v1.0.0 -m "mPaaS JSAPI 代理系统 v1.0.0"
git push origin v1.0.0
```

---

## 完成标志

当所有任务完成后，你应该拥有:

✅ 一个可运行的代理服务器（Node.js）
✅ 一个可运行的代理小程序（mPaaS）
✅ 一个可用的模拟器客户端（JavaScript）
✅ 完整的设计文档
✅ 详细的测试指南

系统应该能够:
- 在模拟器中拦截 my.call 调用
- 通过 WebSocket 转发到真机小程序
- 在真机上执行真实的 my.call
- 将结果返回给模拟器
- 正确处理错误和断线情况
