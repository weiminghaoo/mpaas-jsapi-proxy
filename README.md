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
