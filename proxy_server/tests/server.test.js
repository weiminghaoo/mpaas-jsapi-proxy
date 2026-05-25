const WebSocket = require('ws');
const { ProxyServer } = require('../src/server');

describe('ProxyServer', () => {
  let server;
  const testPort = 3001;

  beforeEach((done) => {
    // 启动测试服务器
    server = new ProxyServer({ port: testPort });
    server.start();
    // 等待服务器完全启动
    setTimeout(done, 100);
  });

  afterEach((done) => {
    // 停止服务器
    if (server) {
      server.stop();
    }
    // 等待服务器完全关闭
    setTimeout(done, 100);
  });

  test('应该成功启动服务器', () => {
    expect(server.wss).toBeDefined();
    expect(server.wss.options.port).toBe(testPort);
  });

  test('应该接受WebSocket连接', (done) => {
    const ws = new WebSocket(`ws://localhost:${testPort}/ws?type=miniapp`);

    ws.on('open', () => {
      ws.close();
      done();
    });

    ws.on('error', (error) => {
      done(error);
    });
  });

  test('应该处理设备注册消息', (done) => {
    const ws = new WebSocket(`ws://localhost:${testPort}/ws?type=miniapp`);

    ws.on('open', () => {
      // 发送注册消息
      ws.send(JSON.stringify({
        type: 'register',
        msgId: 'test-msg-1',
        deviceId: 'test-device-1',
        deviceInfo: { model: 'iPhone 14' }
      }));
    });

    ws.on('message', (data) => {
      const message = JSON.parse(data);
      expect(message.type).toBe('register');
      expect(message.success).toBe(true);
      expect(message.deviceId).toBe('test-device-1');
      ws.close();
      done();
    });

    ws.on('error', (error) => {
      done(error);
    });
  });

  test('应该处理心跳消息', (done) => {
    const ws = new WebSocket(`ws://localhost:${testPort}/ws?type=miniapp`);

    ws.on('open', () => {
      // 先注册设备
      ws.send(JSON.stringify({
        type: 'register',
        msgId: 'test-msg-2',
        deviceId: 'test-device-2',
        deviceInfo: {}
      }));

      // 发送心跳
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'heartbeat',
          msgId: 'test-msg-3',
          deviceId: 'test-device-2'
        }));

        // 验证设备仍在管理器中
        setTimeout(() => {
          const device = server.deviceManager.getDevice('test-device-2');
          expect(device).toBeDefined();
          ws.close();
          done();
        }, 50);
      }, 50);
    });

    ws.on('error', (error) => {
      done(error);
    });
  });

  test('应该正确处理断开连接', (done) => {
    const ws = new WebSocket(`ws://localhost:${testPort}/ws?type=miniapp`);

    ws.on('open', () => {
      // 注册设备
      ws.send(JSON.stringify({
        type: 'register',
        msgId: 'test-msg-4',
        deviceId: 'test-device-3',
        deviceInfo: {}
      }));
    });

    setTimeout(() => {
      // 验证设备已注册
      const device = server.deviceManager.getDevice('test-device-3');
      expect(device).toBeDefined();

      // 关闭连接
      ws.close();
    }, 50);

    setTimeout(() => {
      // 验证设备已从管理器中移除
      const device = server.deviceManager.getDevice('test-device-3');
      expect(device).toBeUndefined();
      done();
    }, 150);
  });

  test('应该能够停止服务器', () => {
    expect(() => {
      server.stop();
    }).not.toThrow();
  });
});
