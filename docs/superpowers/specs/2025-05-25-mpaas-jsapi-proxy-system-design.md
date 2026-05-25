# mPaaS JSAPI 代理系统设计文档

**日期:** 2025-05-25
**状态:** 设计阶段
**作者:** Claude + 用户

## 概述

为 mPaaS 小程序开发一个代理系统，将模拟器环境中的 `my.call` 调用转发到真机小程序执行，使开发者能够在开发阶段使用真实的设备能力进行测试。

### 核心需求

1. **代理服务器** - WebSocket 中转服务器，纯 Node.js 实现
2. **代理小程序** - 运行在真机上，接收并执行真实的 my.call 调用
3. **模拟器客户端** - 自动劫持 my.call，透明地将调用转发到真机

### 使用场景

开发者需要在模拟器环境中测试需要真实设备能力的 JSAPI（如扫码、定位、支付等），通过代理系统将这些调用转发到真机执行。

## 系统架构

### 整体架构图

```
┌─────────────────┐                    ┌─────────────────┐                    ┌─────────────────┐
│   模拟器环境      │                    │   代理服务器      │                    │   真机小程序      │
│                 │                    │                 │                    │                 │
│ ┌─────────────┐ │  WebSocket 连接     │ ┌─────────────┐ │  WebSocket 连接     │ ┌─────────────┐ │
│ │ 代理客户端   │ │◄──────────────────►│ │  连接管理器   │ │◄──────────────────►│ │ 代理小程序   │ │
│ │             │ │  (ws://192.168.x.x)│ │             │ │  (每个设备独立连接) │ │             │ │
│ └──────┬──────┘ │                    │ └──────┬──────┘ │                    │ └──────┬──────┘ │
│        │        │                    │        │        │                    │        │        │
│        ▼        │                    │        ▼        │                    │        ▼        │
│ ┌─────────────┐ │                    │ ┌─────────────┐ │                    │ ┌─────────────┐ │
│ │my.call 劫持  │ │                    │ │  消息路由    │ │                    │ │ 真实 my.call│ │
│ │             │ │                    │ │             │ │                    │ │             │ │
│ └─────────────┘ │                    │ └─────────────┘ │                    │ └─────────────┘ │
└─────────────────┘                    └─────────────────┘                    └─────────────────┘
```

### 核心组件

#### 1. 代理服务器

- **职责**: WebSocket 中转服务器，维护设备连接映射
- **技术栈**: Node.js + ws 库
- **部署**: 本地或内网服务器，局域网地址访问

**核心功能**:
- 监听 WebSocket 端口，接受模拟器和小程序连接
- 维护设备映射表：`deviceId → { simulatorWS, miniappWS, deviceInfo }`
- 消息路由：根据 deviceId 和 msgId 转发消息
- 终端显示注册二维码信息

#### 2. 代理小程序

- **职责**: 真机端的代理客户端，执行真实的 my.call
- **技术栈**: mPaaS 小程序框架

**核心功能**:
- 生成并持久化唯一设备 ID（存储在 my.setStorageSync）
- 扫码/手动输入服务器地址进行注册
- 建立 WebSocket 长连接
- 接收代理请求，调用真实 my.call
- 返回执行结果
- 心跳保活机制

#### 3. 模拟器代理客户端

- **职责**: 劫持 my.call，透明地将调用转发到代理服务器
- **文件**: my-call-proxy.js
- **技术栈**: 纯 JavaScript，支持 CommonJS

**核心功能**:
- 自动劫持原生 my.call 方法
- 生成唯一 msgId（UUID 格式）
- 维护 `msgId → callback` 映射表
- WebSocket 长连接到代理服务器
- 根据响应 msgId 匹配并执行回调
- 连接断开时快速失败

## 消息协议设计

### 通用消息结构

所有 WebSocket 消息均为 JSON 格式：

```typescript
interface Message {
  type: 'register' | 'call' | 'response' | 'error' | 'heartbeat';
  msgId: string;           // 消息唯一ID，用于匹配请求和响应
  deviceId: string;        // 设备ID
  timestamp: number;       // Unix时间戳
}
```

### 消息类型定义

#### 1. 设备注册消息

**小程序 → 代理服务器**
```json
{
  "type": "register",
  "msgId": "msg_register_001",
  "deviceId": "device_abc123",
  "timestamp": 1716592000000,
  "deviceInfo": {
    "model": "iPhone 15",
    "system": "iOS 17.0",
    "appVersion": "1.0.0"
  }
}
```

**代理服务器 → 小程序（响应）**
```json
{
  "type": "register",
  "msgId": "msg_register_001",
  "deviceId": "device_abc123",
  "timestamp": 1716592000000,
  "success": true
}
```

#### 2. API 调用消息

**模拟器 → 代理服务器**
```json
{
  "type": "call",
  "msgId": "msg_001",
  "deviceId": "device_abc123",
  "timestamp": 1716592000000,
  "api": "scan",
  "params": {
    "type": "qr"
  }
}
```

**代理服务器 → 小程序（透传）**
```json
{
  "type": "call",
  "msgId": "msg_001",
  "deviceId": "device_abc123",
  "api": "scan",
  "params": {
    "type": "qr"
  }
}
```

#### 3. 响应消息

**小程序 → 代理服务器**
```json
{
  "type": "response",
  "msgId": "msg_001",
  "deviceId": "device_abc123",
  "timestamp": 1716592001000,
  "result": {
    "code": "10000",
    "resultValue": "https://example.com"
  }
}
```

**代理服务器 → 模拟器（透传）**
```json
{
  "type": "response",
  "msgId": "msg_001",
  "deviceId": "device_abc123",
  "result": {
    "code": "10000",
    "resultValue": "https://example.com"
  }
}
```

#### 4. 错误消息

```json
{
  "type": "error",
  "msgId": "msg_001",
  "deviceId": "device_abc123",
  "timestamp": 1716592001000,
  "error": {
    "code": "DEVICE_OFFLINE",
    "message": "代理小程序已离线"
  }
}
```

#### 5. 心跳消息

**小程序 → 代理服务器（每30秒）**
```json
{
  "type": "heartbeat",
  "msgId": "heartbeat_1716592030000",
  "deviceId": "device_abc123",
  "timestamp": 1716592030000
}
```

### 消息ID机制

**设计目标**: 确保每个请求和响应正确匹配，防止消息串扰

**实现方式**:
- 模拟器客户端生成 msgId（格式：`msg_${timestamp}_${counter}`）
- msgId 贯穿整个通信链路
- 每个端点维护 msgId → callback 映射表
- 响应时返回同一个 msgId 用于匹配

**消息流程**:
```
模拟器                          代理服务器                    真机小程序
  │                              │                            │
  │  1. my.call('scan', {}, cb) │                            │
  │  生成 msgId: "msg_001"       │                            │
  │                              │                            │
  ├─ WebSocket ─────────────────►                            │
  │  { msgId: "msg_001", ... }    │                            │
  │                              │                            │
  │                              ├─ WebSocket ───────────────►│
  │                              │  { msgId: "msg_001", ... }  │
  │                              │                            │
  │                              │  my.call('scan', {}, (res)  │
  │                              │                            │
  │                              │◄─ WebSocket ───────────────┤
  │                              │  { msgId: "msg_001", ... }  │
  │                              │                            │
  │◄─ WebSocket ─────────────────┤                            │
  │  { msgId: "msg_001", ... }    │                            │
  │                              │                            │
  │  执行回调 cb(result)          │                            │
```

## 目录结构

### 代理服务器
```
proxy_server/
├── package.json
├── index.js              # 主入口
├── config.js             # 配置文件
└── src/
    ├── server.js         # WebSocket 服务器
    ├── device-manager.js # 设备连接管理
    ├── message-router.js # 消息路由
    └── utils.js          # 工具函数
```

### 代理小程序
```
pages/
├── index/
│   ├── index.js
│   ├── index.json
│   ├── index.axml
│   └── index.acss
└── proxy/
    ├── proxy.js           # 代理核心逻辑
    ├── proxy.json
    ├── proxy.axml         # 界面
    └── proxy.acss

utils/
└── storage.js             # 本地存储工具

app.js                      # 全局配置
```

### 模拟器客户端
```
my-call-proxy.js           # 单文件，支持 CommonJS
```

## 核心实现要点

### 代理服务器

**设备管理**:
```javascript
class DeviceManager {
  // deviceId → { miniappWS, simulatorWS, deviceInfo, lastHeartbeat }
  devices = new Map();

  registerDevice(deviceId, miniappWS, deviceInfo);
  connectSimulator(deviceId, simulatorWS);
  disconnect(ws);
  getDevice(deviceId);
  isDeviceReady(deviceId);
}
```

**消息路由**:
- 接收模拟器的 `call` 消息 → 转发到对应小程序
- 接收小程序的 `response` 消息 → 转发到对应模拟器
- 错误处理：设备未注册、设备离线、消息格式错误

**终端输出**:
- 启动时显示服务器地址和端口
- 显示注册二维码信息（文本形式）
- 实时显示设备连接状态

### 代理小程序

**设备ID管理**:
```javascript
// 生成唯一设备ID
generateDeviceId() {
  return 'device_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// 持久化存储
getDeviceId() {
  let deviceId = my.getStorageSync({ key: 'proxy_device_id' }).data;
  if (!deviceId) {
    deviceId = this.generateDeviceId();
    my.setStorageSync({ key: 'proxy_device_id', data: deviceId });
  }
  return deviceId;
}
```

**WebSocket 连接**:
- 使用 `my.connectSocket` 建立 WebSocket 连接
- 监听 `onSocketOpen`、`onSocketMessage`、`onSocketError`、`onSocketClose`
- 30秒心跳保活

**API 调用处理**:
```javascript
handleApiCall(message) {
  const { msgId, api, params } = message;

  my.call(api, params || {}, (result) => {
    const response = {
      type: 'response',
      msgId: msgId,
      deviceId: this.deviceId,
      timestamp: Date.now(),
      result: result
    };

    my.sendSocketMessage({
      data: JSON.stringify(response)
    });
  });
}
```

### 模拟器客户端

**my.call 劫持**:
```javascript
init() {
  // 保存原始方法
  this.originalMyCall = my.call;

  // 劫持
  const self = this;
  my.call = function(api, params, callback) {
    if (self.isConnected) {
      self.proxyCall(api, params, callback);
    } else {
      self.originalMyCall.call(this, api, params, callback);
    }
  };
}
```

**回调管理**:
```javascript
// 存储回调
this.pendingCalls.set(msgId, {
  callback: callback || (() => {}),
  timestamp: Date.now()
});

// 匹配并执行
handleMessage(message) {
  const { type, msgId, result } = message;
  const pending = this.pendingCalls.get(msgId);
  if (pending) {
    pending.callback(result);
    this.pendingCalls.delete(msgId);
  }
}
```

**快速失败**:
- WebSocket 断开时立即拒绝所有等待中的调用
- 不进行重连或队列暂存

## 使用流程

### 1. 启动代理服务器

```bash
cd proxy_server
npm install
npm start
```

终端显示：
```
🚀 代理服务器启动成功
📡 监听端口: 3000

╔════════════════════════════════════════════════════════════╗
║            mPaaS JSAPI 代理服务器                          ║
╠════════════════════════════════════════════════════════════╣
║  请在代理小程序中扫描以下二维码进行注册                    ║
║                                                            ║
║  ws://192.168.1.100:3000/ws?type=miniapp                  ║
║                                                            ║
║  或手动输入地址：                                           ║
║  ws://192.168.1.100:3000/ws?type=miniapp                  ║
╚════════════════════════════════════════════════════════════╝
```

### 2. 小程序注册

1. 打开代理小程序
2. 输入服务器地址：`ws://192.168.1.100:3000`
3. 点击"连接"按钮
4. 小程序自动注册，显示"已连接"状态
5. 复制显示的代理地址（包含 deviceId）

### 3. 模拟器集成

```javascript
// 在模拟器项目中引入
const { MyCallProxy } = require('./my-call-proxy.js');

// 创建代理实例（使用小程序显示的地址）
const proxy = new MyCallProxy('ws://192.168.1.100:3000?deviceId=device_abc123');
proxy.init();

// 之后所有 my.call 调用都自动通过代理
my.call('scan', { type: 'qr' }, (result) => {
  console.log(result); // 真机扫码的结果
});
```

## 技术决策

### 为什么选择 WebSocket？

- **实时性**: 长连接，消息即时传递
- **双向通信**: 支持服务器主动推送（如心跳、错误通知）
- **低延迟**: 相比 HTTP 轮询，延迟更低
- **连接状态**: 易于检测设备在线/离线状态

### 为什么选择快速失败？

- **简单**: 无需复杂的重连和队列逻辑
- **快速反馈**: 问题立即暴露，便于调试
- **适用场景**: 开发环境，无需高可靠性保证

### 为什么小程序生成设备ID？

- **无状态服务器**: 服务器重启不影响小程序
- **持久化**: 小程序关闭重启后 ID 不变
- **简单**: 服务器只需维护内存中的连接映射

## 错误处理

### 错误类型

1. **设备未注册**: `DEVICE_NOT_FOUND`
2. **设备离线**: `DEVICE_OFFLINE`
3. **消息格式错误**: `INVALID_MESSAGE`
4. **WebSocket 错误**: 连接失败、连接断开

### 错误响应

```json
{
  "type": "error",
  "msgId": "msg_001",
  "deviceId": "device_abc123",
  "error": {
    "code": "DEVICE_OFFLINE",
    "message": "代理小程序已离线"
  }
}
```

### 容错机制

- 模拟器端：连接断开时回退到原始 my.call
- 小程序端：连接断开时提示用户重连
- 服务器端：清理离线设备连接

## 安全考虑

### 局域网部署

- 服务器仅监听局域网地址
- 不建议暴露到公网

### 输入验证

- 验证消息格式和必要字段
- 限制消息大小，防止资源耗尽

### 连接管理

- 心跳检测，自动清理死连接
- 限制单个设备的连接数

## 未来扩展

### 可能的增强功能

1. **日志记录**: 记录所有 API 调用和响应
2. **多设备支持**: 支持多个模拟器连接到不同小程序
3. **API 黑白名单**: 限制某些敏感 API 的代理
4. **性能统计**: 统计 API 调用次数、响应时间
5. **可视化界面**: Web 界面显示设备状态和调用日志

## 依赖清单

### 代理服务器

- `ws`: WebSocket 库
- `qrcode-terminal`: 终端二维码显示（可选）

### 代理小程序

- mPaaS 小程序框架
- 无额外依赖

### 模拟器客户端

- 无外部依赖，纯 JavaScript

## 总结

本设计实现了一个简单高效的 mPaaS JSAPI 代理系统，通过 WebSocket 长连接将模拟器的 my.call 调用转发到真机执行。核心特点：

1. **消息ID机制**: 确保请求响应正确匹配
2. **透明代理**: 自动劫持 my.call，无需修改现有代码
3. **快速失败**: 连接断开立即返回错误
4. **纯 Node.js**: 代理服务器无前端依赖
5. **设备ID持久化**: 小程序重启后仍可使用

该设计专注于开发场景，架构简单，易于实现和维护。
