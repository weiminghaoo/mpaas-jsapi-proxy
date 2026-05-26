const express = require('express');
const { ProxyServer } = require('./src/server');
const { HttpHandler } = require('./src/http-handler');
const { ResponseQueue } = require('./src/response-queue');
const config = require('./config');

const app = express();
app.use(express.json());

const proxyServer = new ProxyServer(config);
const responseQueue = new ResponseQueue();
const httpHandler = new HttpHandler(
  proxyServer.getDeviceManager(),
  responseQueue
);

app.use('/api/proxy', httpHandler.getRouter());

proxyServer.start();

const server = proxyServer.getHttpServer();

server.on('request', (req, res) => {
  if (req.url === '/ws' || req.url.startsWith('/ws?')) {
    return;
  }
  app(req, res);
});

process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  proxyServer.stop();
  process.exit(0);
});
