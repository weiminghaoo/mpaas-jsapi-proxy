// example-usage.js
// 模拟器项目需先执行：npm install mpaas-jsapi-proxy --save
import MyCallProxy from 'mpaas-jsapi-proxy';

// ⚠️ 重要：使用从真机小程序复制的设备ID
// 步骤：
// 1. 在真机上打开代理小程序并连接
// 2. 扫描获取服务器配置
// 3. 复制连接参数，替换下面的
const proxy = new MyCallProxy('ws://192.168.0.12:3000?deviceId=device_1779766272138_e5xft0yey');
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
