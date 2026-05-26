const { ProxyServer } = require('./src/server');
// const { HttpServer } = require('./src/http-server');
const config = require('./config');

const proxyServer = new ProxyServer(config);

// const httpServer = new HttpServer(proxyServer.deviceManager);
// proxyServer.messageRouter.setHttpServer(httpServer);

// 启动 WebSocket 服务器
proxyServer.start();

// // 启动 HTTP 服务器（端口 3001）
// httpServer.start(3001);

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  proxyServer.stop();
  // httpServer.stop();
  process.exit(0);
});
