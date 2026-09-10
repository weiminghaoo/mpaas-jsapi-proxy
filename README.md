# mPaaS JSAPI Proxy

mPaaS 小程序 JSAPI 代理：将模拟器中的 `my.call` 调用通过 WebSocket 转发到真机执行。

本仓库包含两部分：

| 目录 | 说明 |
|------|------|
| 根目录 | npm 主项目 `mpaas-jsapi-proxy`：代理服务器（`mpaas-jsapi-proxy` 命令）+ 模拟器客户端代理 |
| `miniapp/` | 真机代理小程序（mPaaS 小程序工程），运行在真机上接收并执行 API 调用 |

## 系统架构

```
模拟器 (开发者工具) ←→ 代理服务器 (本项目) ←→ 真机小程序 (miniapp/)
```

## 功能特性

- WebSocket 代理服务器，支持 JSAPI 消息转发
- 设备连接管理、消息路由和分发、心跳检测
- 终端二维码显示服务器地址
- 模拟器客户端 `MyCallProxy`：透明劫持 `my.call`，npm 包直接引用，无需复制代码
- 蓝牙代理开关：`{ bluetooth: true }` 仅代理蓝牙 API（含事件多播）到真机，其余保持模拟器本地执行

## 快速开始

### 1. 启动代理服务器

```bash
# 全局安装
npm install -g mpaas-jsapi-proxy

# 启动服务器
mpaas-jsapi-proxy
```

### 2. 真机小程序连接

在真机上运行 `miniapp/` 小程序，输入服务器地址并连接，复制连接参数（含设备ID）。

### 3. 模拟器客户端接入

在模拟器所在的小程序项目中安装本包：

```bash
npm install mpaas-jsapi-proxy --save
```

在 `app.js` 中初始化（连接参数从真机小程序复制）。**包的默认导出即客户端代理**，自带 TypeScript 类型声明（d.ts）：

```javascript
import MyCallProxy from 'mpaas-jsapi-proxy';

const proxy = new MyCallProxy('ws://192.168.0.12:3000?deviceId=device_xxx');
proxy.init();

// 之后所有 my.call 自动通过代理转发到真机
my.call('scan', { type: 'qr' }, (result) => {
  console.log(result);
});
```

### 蓝牙代理模式（可选）

模拟器不支持蓝牙调试时，可开启蓝牙开关：只把蓝牙相关 API 转发到真机执行，其余 `my.*` 调用（含业务自定义 JSAPI）保持模拟器本地执行：

```javascript
import MyCallProxy from 'mpaas-jsapi-proxy';

const proxy = new MyCallProxy('ws://192.168.0.12:3000?deviceId=device_xxx', { bluetooth: true });
proxy.init();

// 一次性 API 走真机，success/fail 按真机结果自动路由
my.openBluetoothAdapter({
  success: (res) => console.log('适配器已打开', res),
  fail: (err) => console.error('打开失败', err),
});

// 监听类 API：真机触发，经服务器多播回模拟器
my.onBluetoothDeviceFound((res) => {
  console.log('发现设备', res.devices);
});
```

开启后：

- 一次性 API（`openBluetoothAdapter`、`writeBLECharacteristicValue`、`getBluetoothDevices` 等）原路返回
- 监听类 API（`onBluetoothDeviceFound`、`onBLECharacteristicValueChange` 等）由真机触发多播，`offXxx` 全量解绑并同步真机
- `my.call` 与其他 `my.*` API 完全不受影响；不传 `bluetooth` 时保持原有全量代理行为
- 注意：蓝牙模式下若通过 `my.call('openBluetoothAdapter', ...)` 泛化方式调用蓝牙 API，**不会**被代理（该模式不劫持 `my.call`），请使用具名 API 写法

## 开发

```bash
# 安装依赖
pnpm install

# 开发模式（热重载）
pnpm run dev

# 构建（产物：dist/ 下 js + d.ts）
#   dist/index.js   客户端代理（默认导出，d.ts 随包发布）
#   dist/server.js  服务器 CLI 入口（仅通过 mpaas-jsapi-proxy 命令使用）
pnpm run build

# 类型检查
pnpm run type-check
```

## 发布到 npm

```bash
# 构建
pnpm run build

# 预览包内容
npm pack --dry-run

# 发布
npm publish
```

## 目录结构

```
├── src/                    # TypeScript 源码
│   ├── index.ts            # 模拟器客户端代理（默认导出，打包为 dist/index.js）
│   └── server/             # 代理服务器（打包为 dist/server.js）
│       ├── index.ts        # 服务器 CLI 入口
│       ├── server.ts       # WebSocket 服务器
│       ├── config.ts       # 配置
│       ├── device-manager.ts
│       ├── message-router.ts
│       └── utils.ts
├── bin/                    # CLI 入口（指向 dist/server.js）
├── dist/                   # 构建产物（js + d.ts，随 npm 发布）
├── tsconfig.build.json     # d.ts 声明文件生成配置
└── miniapp/                # 真机代理小程序子项目
```

## 导出入口

| 导入路径 | 内容 |
|---------|------|
| `mpaas-jsapi-proxy` | 客户端代理 `MyCallProxy`（默认导出） |

服务器不作为包导出，仅通过 CLI 使用：`mpaas-jsapi-proxy`。

## 技术栈

- **TypeScript** - 类型安全的开发体验
- **Vite** - 快速的构建工具
- **WebSocket** - 实时双向通信
- **qrcode-terminal** - 终端二维码显示

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！
