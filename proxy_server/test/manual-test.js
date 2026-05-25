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