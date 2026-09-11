# mPaaS JSAPI 代理使用指南

## 系统架构

```
模拟器 (开发者工具) ←→ 代理服务器 ←→ 真机小程序
```

## 快速开始

### 1. 启动代理服务器

在仓库根目录（主项目）执行：

```bash
pnpm install
pnpm run build
pnpm start
```

或全局安装后直接运行：

```bash
npm install -g mpaas-jsapi-proxy
mpaas-jsapi-proxy
```

服务器会显示：
```
║  ws://192.168.0.12:3000/ws                                 ║
```

### 2. 真机小程序连接

1. **在真机上打开**代理小程序（pages/index/index）
2. 输入服务器地址，或点击输入框右侧的扫码图标，扫描服务器终端二维码自动填入
3. 点击"连接"
4. 等待注册成功提示
5. **点击"复制连接参数"按钮**（会复制：`ws://192.168.0.12:3000?deviceId=device_1716732000000_abc123def`）

扫码支持以下三种二维码内容（解析出 `ws://` / `wss://` 地址即自动填入）：

| 格式 | 示例 |
|------|------|
| 服务端终端二维码 | `xlmpaas://2026052614145188?url=ws%3A%2F%2F192.168.0.12%3A3000` |
| 裸参数串 | `url=ws%3A%2F%2F192.168.0.12%3A3000&deviceId=device_xxx` |
| 地址本身 | `ws://192.168.0.12:3000` |

### 3. 配置模拟器客户端

在模拟器项目中安装 npm 包：

```bash
npm install mpaas-jsapi-proxy --save
```

打开 `app.js`，从 npm 包引入客户端代理，并填入从真机复制的连接参数：

```javascript
import MyCallProxy from 'mpaas-jsapi-proxy';

const proxy = new MyCallProxy('ws://192.168.0.12:3000?deviceId=device_1716732000000_abc123def');
proxy.init();
```

也可以直接在小程序页面点击"模拟器客户端接入"中的初始化代码，复制已自动填入服务器地址与设备ID的接入片段。

**提示**：复制的是纯文本，粘贴到代码时记得加上单引号或双引号。

### 4. 测试代理

在开发者工具中运行小程序，执行：

```javascript
my.call('xlGetAppInfo', {}, (result) => {
  console.log(result);  // 将在真机上执行
});
```

### 5. 蓝牙代理模式

模拟器端初始化时传入 `{ bluetooth: true }`，即可把蓝牙相关 API 转发到真机执行（监听类 API 由真机触发、多播回模拟器）：

```javascript
const proxy = new MyCallProxy('ws://192.168.0.12:3000?deviceId=device_xxx', { bluetooth: true });
proxy.init();

my.openBluetoothAdapter({
  success: (res) => console.log(res),
  fail: (err) => console.error(err),
});
```

真机小程序无需额外配置，自动支持事件订阅（`onBluetoothDeviceFound` 等）、解绑（`offXxx`）与订阅错误回报的转发。

## 常见问题

### Q: WebSocket 连接失败？

**错误信息**: `连接失败。开发者工具无法获取到具体的 socket 错误信息，请通过真机调试获取`

**原因**: mPaaS 开发者工具对 WebSocket 的支持有限

**解决方案**:
1. 确保服务器正在运行（检查端口 3000）
2. 确保真机小程序已成功连接
3. 确保使用的是真机的设备ID（从真机小程序复制）
4. 如果仍然失败，需要在真机上调试，而不是在开发者工具中

### Q: 代理不生效？

**检查清单**:
- [ ] 服务器正在运行
- [ ] 真机小程序显示"已连接"
- [ ] app.js 中的 deviceId 与真机一致
- [ ] 控制台显示 `[MyCallProxy] ✅ my.call 代理已初始化`
- [ ] 控制台显示 `[MyCallProxy] 🔗 已连接到代理服务器`

### Q: 如何获取设备ID？

在真机小程序页面，设备ID 会显示在界面上，点击"复制设备ID"按钮即可复制。

## 工作原理

1. **真机注册**: 真机小程序连接到服务器，发送注册消息，生成唯一设备ID
2. **模拟器连接**: 模拟器使用相同的设备ID连接到服务器
3. **消息路由**: 服务器将模拟器的 API 调用转发给对应的真机
4. **结果返回**: 真机执行结果通过服务器返回给模拟器

## 开发调试

### 查看服务器日志

在仓库根目录执行：

```bash
pnpm start
```

服务器会显示：
- 连接事件
- 消息转发
- 设备状态

### 查看真机日志

使用 mPaaS 提供的真机调试工具查看小程序控制台输出。

### 查看模拟器日志

在开发者工具的控制台中查看：
- `[MyCallProxy]` 开头的日志是代理相关
- 连接状态
- 消息发送/接收

## 注意事项

⚠️ **重要**:
- 模拟器和真机必须连接到同一个服务器
- deviceId 必须完全一致（区分大小写）
- 确保网络通畅（真机和服务器在同一局域网）
- 开发者工具的 WebSocket 支持有限，建议在真机上测试
