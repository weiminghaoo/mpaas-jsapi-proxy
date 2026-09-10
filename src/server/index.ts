import { ProxyServer } from './server';
import config from './config';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2));

// 合并配置：命令行参数优先
const finalConfig = {
  ...config,
  ...(args.p !== undefined && { port: Number(args.p) }),
  ...(args.port !== undefined && { port: Number(args.port) }),
};

const proxyServer = new ProxyServer(finalConfig);

// 启动 WebSocket 服务器
proxyServer.start();

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  proxyServer.stop();
  process.exit(0);
});
