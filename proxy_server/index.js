const { ProxyServer } = require('./src/server');
const config = require('./config');

const server = new ProxyServer(config);

// 启动服务器
server.start();

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  server.stop();
  process.exit(0);
});
