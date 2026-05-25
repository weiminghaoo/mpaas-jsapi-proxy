# 代理服务器测试指南

## 测试说明

此目录包含代理服务器的测试脚本，用于验证服务器功能是否正常工作。

## 手动测试

### 前置条件

1. 确保已安装 Node.js
2. 已安装项目依赖

### 安装依赖

```bash
cd proxy_server
npm install
```

### 启动服务器

```bash
npm start
```

服务器应该会显示：
```
代理服务器运行在端口 3000
WebSocket 服务器运行在 ws://localhost:3000/ws
```

### 运行手动测试

在另一个终端窗口中运行：

```bash
node test/manual-test.js
```

### 预期结果

1. **连接成功**
   ```
   连接到服务器: ws://localhost:3000/ws?type=miniapp
   ✅ 已连接
   📤 发送注册消息
   ```

2. **收到注册响应**
   ```
   📥 收到消息: {
     "type": "register_response",
     "msgId": "msg_register_...",
     "deviceId": "device_test_001",
     "success": true,
     "timestamp": ...
   }
   ```

3. **服务器日志显示连接信息**
   ```
   新的小程序连接: device_test_001
   设备注册成功: device_test_001
   ```

## 测试场景

### 1. 基本连接测试
- 验证 WebSocket 连接建立
- 验证设备注册流程
- 验证消息收发

### 2. 多设备测试
可以同时运行多个测试脚本实例，模拟多个小程序设备：

```bash
# 终端1
node test/manual-test.js

# 终端2
node test/manual-test.js
```

### 3. 异常情况测试
- 服务器未启动时运行测试（应显示连接错误）
- 发送无效格式的消息
- 网络中断恢复

## 故障排查

### 连接失败
- 检查服务器是否正在运行：`npm start`
- 检查端口 3000 是否被占用
- 检查防火墙设置

### 未收到响应
- 检查服务器日志
- 验证消息格式是否正确
- 确认 WebSocket URL 参数

### 超时
- 检查网络连接
- 验证服务器响应时间
- 增加超时时间

## 下一步

考虑添加以下测试：
- 自动化测试脚本
- 性能测试（压力测试）
- 集成测试
- 端到端测试