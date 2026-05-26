# mPaaS JSAPI Proxy Server

mPaaS 小程序 JSAPI 代理服务器，提供 WebSocket 连接和设备管理功能。


## 功能特性

- WebSocket 服务器，支持 JSAPI 消息代理
- 设备连接管理
- 消息路由和分发
- 心跳检测机制
- 二维码终端显示

## 快速开始

### 直接运行

```bash
# 全局安装
npm install -g mpaas-jsapi-proxy

# 启动服务器
mpaas-jsapi-proxy
```
## 开发

```bash
# 克隆项目
git clone <repository-url>

# 安装依赖
pnpm install

# 开发模式（热重载）
pnpm run dev

# 构建
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

## 技术栈

- **TypeScript** - 类型安全的开发体验
- **Vite** - 快速的构建工具
- **WebSocket** - 实时双向通信
- **qrcode-terminal** - 终端二维码显示

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！
