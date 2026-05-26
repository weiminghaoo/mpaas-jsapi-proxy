const express = require('express');
const { Utils } = require('./utils');

class HttpHandler {
  constructor(deviceManager, responseQueue) {
    this.deviceManager = deviceManager;
    this.responseQueue = responseQueue;
    this.router = express.Router();
    this.setupRoutes();
  }

  setupRoutes() {
    this.router.post('/call', express.json(), this.handleCall.bind(this));
    this.router.get('/response', this.handlePolling.bind(this));
    this.router.post('/register', express.json(), this.handleRegister.bind(this));
  }

  async handleCall(req, res) {
    const { deviceId, msgId, api, params } = req.body;

    if (!deviceId || !msgId || !api) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: '缺少必要参数'
      });
    }

    const device = this.deviceManager.getDevice(deviceId);
    if (!device || !device.miniappWS) {
      return res.status(503).json({
        error: 'DEVICE_OFFLINE',
        message: '真机小程序未连接'
      });
    }

    try {
      device.miniappWS.send(JSON.stringify({
        type: 'call',
        msgId,
        deviceId,
        api,
        params: params || {},
        timestamp: Date.now()
      }));

      Utils.log(`[HTTP] 转发调用: ${api} → ${deviceId}`, 'info');
      res.json({ success: true, message: '调用已转发' });
    } catch (error) {
      res.status(500).json({
        error: 'SEND_FAILED',
        message: error.message
      });
    }
  }

  async handlePolling(req, res) {
    const { deviceId } = req.query;

    if (!deviceId) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: '缺少 deviceId 参数'
      });
    }

    try {
      const response = await this.responseQueue.poll(deviceId, 30000);
      if (response) {
        res.json(response);
      } else {
        res.json({ type: 'timeout' });
      }
    } catch (error) {
      res.status(500).json({
        error: 'POLL_FAILED',
        message: error.message
      });
    }
  }

  async handleRegister(req, res) {
    const { deviceId, deviceInfo } = req.body;

    if (!deviceId) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: '缺少 deviceId'
      });
    }

    this.deviceManager.registerDevice(deviceId, null, deviceInfo);
    Utils.log(`[HTTP] 设备注册: ${deviceId}`, 'info');
    res.json({ success: true, message: '注册成功' });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = { HttpHandler };
