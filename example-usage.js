// example-usage.js
const { MyCallProxy } = require('./my-call-proxy.js');

// 创建代理实例
// 注意: deviceId 参数需要从代理小程序中获取
const proxy = new MyCallProxy('ws://192.168.1.100:3000?deviceId=device_abc123');

// 初始化代理
proxy.init();

// 之后所有 my.call 调用都会自动通过代理转发到真机
my.call('scan', { type: 'qr' }, (result) => {
  console.log('扫码结果:', result);
});

// 检查代理状态
console.log('代理状态:', proxy.getStatus());

// 如需销毁代理
// proxy.destroy();
