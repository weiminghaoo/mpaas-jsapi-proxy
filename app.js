


import MyCallProxy from './my-call-proxy.js';

// ⚠️ 重要：使用从真机小程序复制的设备ID
// 步骤：
// 1. 在真机上打开代理小程序并连接
// 2. 复制显示的设备ID
// 3. 将下面的 deviceId 替换为真实的设备ID
const proxy = new MyCallProxy('ws://192.168.0.12:3000?deviceId=device_1779766272138_e5xft0yey');
proxy.init();

setTimeout(() => {
  my.call('xlGetAppInfo', {}, (res) => {
    console.log(res)
  })
}, 2000)
App({
  onLaunch(options) {
    // 第一次打开
    // options.query == {number:1}
    console.info('App onLaunch');

  
  },
  onShow(options) {
    // 从后台被 scheme 重新打开
    // options.query == {number:1}
  },
});
