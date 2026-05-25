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

记录终端显示的服务器地址,例如: `ws://192.168.1.100:3000`

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
4. 扫码后,模拟器应该收到结果:
   - `[MyCallProxy] 📥 响应: msg_xxx`
5. 验证回调函数收到的结果正确

### 5. 测试不同API

尝试调用其他API:
- `my.getLocation` - 获取定位
- `my.chooseImage` - 选择图片
- `my.alert` - 显示弹窗

### 6. 测试错误场景

1. 关闭小程序,模拟器应该收到错误提示
2. 断开网络连接,验证错误处理
3. 重启服务器,验证重连行为

## 预期结果

- 所有 my.call 调用都能正确转发到真机
- 真机执行结果能正确返回给模拟器
- 错误场景能正确处理和提示
