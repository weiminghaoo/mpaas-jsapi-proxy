# 二维码快速配置功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 mPaaS JSAPI 代理服务器添加二维码快速配置功能，用户通过扫描终端显示的二维码即可在小程序中自动填入服务器地址。

**Architecture:** 服务器端使用 qrcode-terminal 生成 ASCII 二维码，内容为 JSON 格式的编码 WebSocket URL；小程序端使用 my.scan API 扫码并解析，自动填充服务器地址。

**Tech Stack:** Node.js (qrcode-terminal), 支付宝小程序 (my.scan API)

---

## 文件结构

### 服务器端
- `proxy_server/package.json` - 添加 qrcode-terminal 依赖
- `proxy_server/src/server.js` - 修改 displayConnectionInfo 方法添加二维码生成

### 小程序端
- `pages/index/index.js` - 添加 scanIcon data 和 scanQRCode 方法
- `pages/index/index.axml` - 修改服务器配置卡片添加扫码按钮
- `pages/index/index.acss` - 添加扫码按钮样式

---

## Task 1: 添加服务器端二维码依赖

**Files:**
- Modify: `proxy_server/package.json`

- [ ] **Step 1: 在 dependencies 中添加 qrcode-terminal**

打开 `proxy_server/package.json`，在 dependencies 对象中添加 qrcode-terminal 依赖：

```json
{
  "name": "mpaas-jsapi-proxy-server",
  "version": "1.0.0",
  "description": "mPaaS JSAPI 代理服务器",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "nodemon --watch src index.js --exec 'node index.js'",
    "test": "jest"
  },
  "keywords": [
    "mpaas",
    "proxy",
    "websocket"
  ],
  "author": "",
  "license": "MIT",
  "dependencies": {
    "ws": "^8.14.0",
    "qrcode-terminal": "^0.12.0"
  },
  "volta": {
    "node": "18.20.8"
  }
}
```

- [ ] **Step 2: 安装依赖**

```bash
cd proxy_server
npm install
```

预期输出：
```
added 1 package, and audited 2 packages in 1s
found 0 vulnerabilities
```

- [ ] **Step 3: 验证安装**

```bash
npm list qrcode-terminal
```

预期输出：
```
mpaas-jsapi-proxy-server@1.0.0 /path/to/proxy_server
└── qrcode-terminal@0.12.0
```

- [ ] **Step 4: 提交依赖添加**

```bash
git add proxy_server/package.json proxy_server/package-lock.json
git commit -m "feat: 添加 qrcode-terminal 依赖用于生成二维码"
```

---

## Task 2: 实现服务器端二维码生成

**Files:**
- Modify: `proxy_server/src/server.js`

- [ ] **Step 1: 添加 QRCode require 语句**

在文件顶部的 require 部分添加 qrcode-terminal 引入：

```javascript
const WebSocket = require('ws');
const QRCode = require('qrcode-terminal');
const { DeviceManager } = require('./device-manager');
const { MessageRouter } = require('./message-router');
const { Utils } = require('./utils');
const config = require('../config');
```

- [ ] **Step 2: 修改 displayConnectionInfo 方法添加二维码生成**

找到 `displayConnectionInfo()` 方法，在现有输出代码之后添加二维码生成代码：

```javascript
  // 显示连接信息
  displayConnectionInfo() {
    const localIP = Utils.getLocalIP();
    const serverUrl = Utils.formatServerUrl(localIP, this.config.port,'');

    console.log(`
╔════════════════════════════════════════════════════════════╗
║            mPaaS JSAPI 代理服务器                          ║
╠════════════════════════════════════════════════════════════╣
║  请在代理小程序中输入以下地址进行注册                      ║
║                                                            ║
║  ${serverUrl.padEnd(58)}║
║                                                            ║
║  或扫描下方二维码快速配置：                                  ║
╚════════════════════════════════════════════════════════════╝
    `);

    // 生成二维码
    console.log('');
    const qrData = JSON.stringify({
      url: encodeURIComponent(serverUrl)
    });
    QRCode.generate(qrData, { small: true });
  }
```

- [ ] **Step 3: 测试二维码生成功能**

启动服务器验证二维码显示：

```bash
cd proxy_server
npm start
```

预期输出：终端显示 ASCII 艺术边框，下方显示可扫描的二维码

- [ ] **Step 4: 停止测试服务器**

按 `Ctrl+C` 停止服务器

- [ ] **Step 5: 提交二维码生成代码**

```bash
git add proxy_server/src/server.js
git commit -m "feat: 添加终端二维码生成功能"
```

---

## Task 3: 小程序端添加扫码方法

**Files:**
- Modify: `pages/index/index.js`

- [ ] **Step 1: 在 data 中添加 scanIcon**

找到 `Page({ data: { ... } })` 部分，在 data 对象中添加 scanIcon 属性：

```javascript
Page({
  data: {
    deviceId: '',
    serverUrl: 'ws://192.168.1.100:3000',
    connectionStatus: '未连接',
    statusClass: 'disconnected',
    scanIcon: 'data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCI+PHBhdGggZmlsbD0iIzY2NiIgZD0iTTMgM2g2djZIM1Yzem0yIDJ2MmgyVjVINW04LTJoNnY2aC02VjN6bTItMnYyaTJINWgtMnpNMyAxM2g2djZIM3YtNn0yIDJ2Mmgydi0ySDV6MTMtMmgzdjJoLTN2LTJ6bTMwaDJ2MmgtMnYtMnptLTMgMmgydjJoLTJ2LTJ6bTIgMmgydjJoLTJ2LTJ6Ii8+PC9zdmc+'
  },
```

- [ ] **Step 2: 添加 scanQRCode 方法**

在 `copyConnectionParams()` 方法之后添加 `scanQRCode()` 方法：

```javascript
  copyConnectionParams() {
    const connectionParams = `${this.data.serverUrl}?deviceId=${this.data.deviceId}`;
    my.setClipboard({
      text: connectionParams
    });
    my.showToast({ content: '连接参数已复制', duration: 1500 });
  },

  scanQRCode() {
    my.scan({
      type: 'qr',
      success: (res) => {
        try {
          const data = JSON.parse(res.qrCodeResult);
          if (data.url) {
            const decodedUrl = decodeURIComponent(data.url);
            if (decodedUrl.startsWith('ws://') || decodedUrl.startsWith('wss://')) {
              this.setData({ serverUrl: decodedUrl });
              my.showToast({ content: '已自动填入服务器地址', duration: 1500 });
              return;
            }
          }
          my.showToast({ content: '无效的二维码格式', duration: 2000 });
        } catch (e) {
          my.showToast({ content: '二维码解析失败', duration: 2000 });
        }
      },
      fail: () => {
        my.showToast({ content: '扫码失败，请重试', duration: 2000 });
      }
    });
  }
});
```

- [ ] **Step 3: 提交扫码方法代码**

```bash
git add pages/index/index.js
git commit -m "feat: 添加二维码扫描方法"
```

---

## Task 4: 小程序端添加扫码按钮

**Files:**
- Modify: `pages/index/index.axml`

- [ ] **Step 1: 修改服务器配置卡片添加扫码按钮**

找到服务器配置卡片部分（`<view class="card-title">服务器配置</view>` 下方），修改 input-row 为 input-row-scan 并添加扫码图标：

```xml
  <view class="card">
    <view class="card-title">服务器配置</view>
    <view class="input-row-scan">
      <input
        class="server-input"
        placeholder="ws://192.168.1.100:3000"
        value="{{serverUrl}}"
        onInput="onServerUrlInput"
      />
      <image class="scan-icon" src="{{scanIcon}}" onTap="scanQRCode" />
    </view>
    <view class="button-row">
      <button class="btn-primary" onTap="connect">连接</button>
      <button class="btn-secondary" onTap="disconnect">断开</button>
    </view>
  </view>
```

- [ ] **Step 2: 提交布局修改**

```bash
git add pages/index/index.axml
git commit -m "feat: 添加扫码按钮到服务器配置卡片"
```

---

## Task 5: 小程序端添加扫码按钮样式

**Files:**
- Modify: `pages/index/index.acss`

- [ ] **Step 1: 添加扫码按钮相关样式**

在文件末尾添加扫码按钮样式：

```css
/* 扫码按钮样式 */
.input-row-scan {
  display: flex;
  align-items: center;
  position: relative;
}

.input-row-scan .server-input {
  padding-right: 60rpx;
}

.scan-icon {
  width: 40rpx;
  height: 40rpx;
  position: absolute;
  right: 20rpx;
  cursor: pointer;
}
```

- [ ] **Step 2: 提交样式修改**

```bash
git add pages/index/index.acss
git commit -m "feat: 添加扫码按钮样式"
```

---

## Task 6: 集成测试

**Files:**
- None (测试)

- [ ] **Step 1: 启动代理服务器**

```bash
cd proxy_server
npm start
```

预期输出：显示包含二维码的服务器信息

- [ ] **Step 2: 记录服务器地址**

从终端输出中记录 WebSocket 服务器地址（如：ws://192.168.0.12:3000）

- [ ] **Step 3: 在小程序开发工具中打开项目**

在支付宝小程序开发工具中打开当前项目

- [ ] **Step 4: 测试扫码功能**

1. 在模拟器或真机上预览小程序
2. 点击服务器地址输入框右侧的扫码图标
3. 模拟扫描步骤（开发工具中使用模拟扫码功能）
4. 验证服务器地址自动填入输入框

- [ ] **Step 5: 测试连接功能**

1. 点击"连接"按钮
2. 验证连接状态显示为"已连接"
3. 验证终端显示设备注册信息

- [ ] **Step 6: 测试错误处理**

手动测试以下场景：
1. 扫描无效的二维码（非 JSON 格式）→ 应显示"二维码解析失败"
2. 扫描无效的 URL（非 ws:// 开头）→ 应显示"无效的二维码格式"

- [ ] **Step 7: 停止测试服务器**

按 `Ctrl+C` 停止服务器

- [ ] **Step 8: 提交所有更改（如有调整）**

```bash
git status
git add .
git commit -m "test: 完成二维码功能集成测试"
```

---

## 完成检查

- [ ] 服务器终端显示二维码
- [ ] 二维码可被正确扫描和解析
- [ ] 小程序扫码按钮可点击
- [ ] 扫码成功后服务器地址自动填充
- [ ] 连接功能正常工作
- [ ] 错误处理正确显示提示信息
