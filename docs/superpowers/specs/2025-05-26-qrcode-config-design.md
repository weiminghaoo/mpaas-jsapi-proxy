# 二维码快速配置功能设计

**日期：** 2025-05-26
**状态：** 待实现

## 概述

为 mPaaS JSAPI 代理服务器添加二维码快速配置功能，用户通过扫描服务器终端显示的二维码，即可在小程序中自动填入服务器地址，简化手动输入过程。

## 需求

1. 服务器启动时在终端显示二维码
2. 小程序端支持扫码并自动填充服务器地址
3. 最小化改动现有代码

## 架构设计

### 服务器端

- 在 `ProxyServer.displayConnectionInfo()` 方法中添加二维码生成
- 使用 `qrcode-terminal` npm 包生成 ASCII 二维码
- 二维码内容：JSON 格式 `{"url":"编码后的WebSocket地址"}`

### 小程序端

- 在服务器配置卡片的输入框后添加扫码按钮
- 使用支付宝小程序的 `my.scan` API 扫描二维码
- 扫描成功后自动填充服务器地址输入框

## 数据流

### 二维码内容格式

```json
{"url":"ws%3A%2F%2F192.168.0.12%3A3000"}
```

- URL 使用 `encodeURIComponent` 编码
- JSON 格式便于扩展其他参数

### 用户操作流程

```
1. 用户点击扫码按钮
2. 调用 my.scan() 启动扫码
3. 扫码成功获取 JSON 数据
4. 解析 JSON 并解码 URL
5. 自动填充到 serverUrl 输入框
6. 用户确认后点击连接按钮
```

## UI 设计

### 服务器端终端输出

```
╔════════════════════════════════════════════════════════════╗
║            mPaaS JSAPI 代理服务器                          ║
╠════════════════════════════════════════════════════════════╣
║  请在代理小程序中输入以下地址进行注册                      ║
║                                                            ║
║  ws://192.168.0.12:3000                                    ║
║                                                            ║
║  或扫描下方二维码快速配置：                                  ║
║                                                            ║
║  ████████████████████████████████████████████████████      ║
║  ██ ████ █   ██ ████ █   ██ ████ ██   ██ ████ ████ ██      ║
╚════════════════════════════════════════════════════════════╝
```

### 小程序端布局

修改 `pages/index/index.axml`：

```xml
<view class="input-row-scan">
  <input
    class="server-input"
    placeholder="ws://192.168.1.100:3000"
    value="{{serverUrl}}"
    onInput="onServerUrlInput"
  />
  <image class="scan-icon" src="{{scanIcon}}" onTap="scanQRCode" />
</view>
```

修改 `pages/index/index.acss`：

```css
.input-row-scan {
  display: flex;
  align-items: center;
  position: relative;
}

.server-input {
  flex: 1;
  padding-right: 60rpx;
}

.scan-icon {
  width: 40rpx;
  height: 40rpx;
  position: absolute;
  right: 20rpx;
}
```

## 实现细节

### 服务器端

**依赖添加：**
```json
// proxy_server/package.json
{
  "dependencies": {
    "qrcode-terminal": "^0.12.0"
  }
}
```

**代码修改：**
```javascript
// proxy_server/src/server.js
const QRCode = require('qrcode-terminal');

ProxyServer.prototype.displayConnectionInfo = function() {
  const localIP = Utils.getLocalIP();
  const serverUrl = Utils.formatServerUrl(localIP, this.config.port, '');

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
};
```

### 小程序端

**代码修改：**

```javascript
// pages/index/index.js

Page({
  data: {
    // ... 现有 data
    scanIcon: 'data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCI+PHBhdGggZmlsbD0iIzY2NiIgZD0iTTMgM2g2djZIM1Yzem0yIDJ2MmgyVjVINW04LTJoNnY2aC02VjN6bTItMnYyaTJINWgtMnpNMyAxM2g2djZIM3YtNn0yIDJ2Mmgydi0ySDV6MTMtMmgzdjJoLTN2LTJ6bTMwaDJ2MmgtMnYtMnptLTMgMmgydjJoLTJ2LTJ6bTIgMmgydjJoLTJ2LTJ6Ii8+PC9zdmc+'
  },

  // ... 现有方法

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

## 错误处理

### 服务器端

| 场景 | 处理方式 |
|------|---------|
| qrcode-terminal 不可用 | 显示警告，不中断启动 |
| 无法获取本地 IP | 使用 localhost 作为回退 |

### 小程序端

| 场景 | 处理方式 |
|------|---------|
| 扫码失败 | Toast 提示"扫码失败，请重试" |
| JSON 解析失败 | Toast 提示"二维码解析失败" |
| URL 格式不正确 | Toast 提示"无效的二维码格式" |
| 用户取消扫码 | 静默处理 |
| 权限被拒绝 | Toast 提示"需要摄像头权限" |

## 测试计划

1. **服务器端测试**
   - 验证二维码正确生成
   - 验证二维码内容可被正确解析

2. **小程序端测试**
   - 验证扫码功能正常调用
   - 验证正确/错误的二维码都能正确处理
   - 验证自动填充功能

3. **集成测试**
   - 完整流程：服务器启动 → 扫码 → 自动填充 → 连接

## 文件变更清单

### 修改的文件
- `proxy_server/package.json` - 添加依赖
- `proxy_server/src/server.js` - 添加二维码生成
- `pages/index/index.js` - 添加扫码方法
- `pages/index/index.axml` - 修改布局添加扫码按钮
- `pages/index/index.acss` - 添加扫码按钮样式

### 新增的文件
无（使用内联 SVG 图标）
