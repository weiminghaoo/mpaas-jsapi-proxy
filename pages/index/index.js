const { Storage } = require('../../utils/storage')
const { parseUrlString } = require('/utils/urlParser')

Page({
  data: {
    deviceId: '',
    serverUrl: 'ws://192.168.1.100:3000',
    connectionStatus: '未连接',
    statusClass: 'disconnected',
    isConnected: false,
    scanIcon: '/assets/scan.svg',
  },

  onLoad() {
    const deviceId = Storage.getDeviceId()
    const cachedServerUrl = Storage.getServerUrl()
    this.setData({
      deviceId,
      serverUrl: cachedServerUrl || this.data.serverUrl,
    })
    this.heartbeatTimer = null
    this._isConnecting = false
    this._hasSetupListeners = false

    my.setKeepScreenOn({
      keepScreenOn: true,
    })

    // 只在页面加载时设置一次事件监听器
    this.setupSocketListeners()
  },

  // 设置 WebSocket 事件监听器（只调用一次）
  setupSocketListeners() {
    if (this._hasSetupListeners) {
      return
    }

    my.onSocketOpen(() => {
      console.log('WebSocket 连接已打开')
      this._isConnecting = false
      this.register()
    })

    my.onSocketMessage((res) => {
      try {
        const message = JSON.parse(res.data)
        this.handleMessage(message)
      } catch (error) {
        console.error('消息解析失败', error)
      }
    })

    my.onSocketError((err) => {
      console.error('WebSocket 错误', err)
      this.setData({
        connectionStatus: '连接错误',
        statusClass: 'error',
        isConnected: false,
      })
      my.showToast({ content: '连接错误', duration: 2000 })
      this._isConnecting = false
    })

    my.onSocketClose(() => {
      console.log('WebSocket 连接已关闭')
      this.setData({
        connectionStatus: '已断开',
        statusClass: 'disconnected',
        isConnected: false,
      })
      this.stopHeartbeat()
      this._isConnecting = false
    })

    this._hasSetupListeners = true
  },

  onUnload() {
    this.disconnect()
    my.setKeepScreenOn({
      keepScreenOn: false,
    })
  },

  onServerUrlInput(e) {
    this.setData({ serverUrl: e.detail.value })
  },

  connect() {
    const serverUrl = this.data.serverUrl.trim()
    if (!serverUrl) {
      my.showToast({ content: '请输入服务器地址', duration: 2000 })
      return
    }

    // 防止重复连接
    if (this._isConnecting) {
      console.log('正在连接中，请勿重复点击')
      return
    }

    this._isConnecting = true
    this.setData({ connectionStatus: '连接中', statusClass: 'connecting' })

    const wsUrl = serverUrl + '/ws?type=miniapp'

    my.connectSocket({
      url: wsUrl,
      success: () => {
        console.log('WebSocket 连接创建成功')
      },
      fail: (err) => {
        console.error('WebSocket 连接失败', err)
        this.setData({
          connectionStatus: '连接失败',
          statusClass: 'error',
          isConnected: false,
        })
        my.showToast({ content: '连接失败: ' + JSON.stringify(err), duration: 3000 })
        this._isConnecting = false
      },
    })
  },

  register() {
    const deviceInfo = Storage.getDeviceInfo()
    const message = {
      type: 'register',
      msgId: 'msg_register_' + Date.now(),
      deviceId: this.data.deviceId,
      timestamp: Date.now(),
      deviceInfo: deviceInfo,
    }

    my.sendSocketMessage({
      data: JSON.stringify(message),
      success: () => {
        console.log('注册消息已发送')
      },
      fail: (err) => {
        console.error('注册消息发送失败', err)
      },
    })
  },

  handleMessage(message) {
    const { type, msgId } = message

    switch (type) {
      case 'register':
        if (message.success) {
          Storage.saveServerUrl(this.data.serverUrl)
          this.setData({
            connectionStatus: '已连接',
            statusClass: 'connected',
            isConnected: true,
          })
          my.showToast({ content: '注册成功！', duration: 2000 })
          this.startHeartbeat()
        }
        break

      case 'client_call':
        this.handleApiCall(message)
        break

      case 'error':
        console.error('收到错误消息', message)
        my.showToast({ content: message.error.message || '发生错误', duration: 2000 })
        break

      default:
        console.log('未处理的消息类型', type)
    }
  },

  handleApiCall(message) {
    const { msgId, api, params } = message

    console.log('执行 API 调用:', api, params)

    my.call(api, params || {}, (result) => {
      console.log('API 返回结果:', result)

      const response = {
        type: 'response',
        msgId: msgId,
        deviceId: this.data.deviceId,
        timestamp: Date.now(),
        result: result,
      }

      my.sendSocketMessage({
        data: JSON.stringify(response),
        fail: (err) => {
          console.error('响应发送失败', err)
        },
      })
    })
  },

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      const heartbeatMsg = {
        type: 'heartbeat',
        msgId: 'heartbeat_' + Date.now(),
        deviceId: this.data.deviceId,
        timestamp: Date.now(),
      }

      my.sendSocketMessage({
        data: JSON.stringify(heartbeatMsg),
        fail: (err) => {
          console.error('心跳发送失败', err)
        },
      })
    }, 30000)
  },

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  },

  disconnect() {
    this.stopHeartbeat()
    my.closeSocket()
    this.setData({
      connectionStatus: '未连接',
      statusClass: 'disconnected',
      isConnected: false,
    })
    my.showToast({ content: '已断开连接', duration: 2000 })
  },

  copyConnectionParams() {
    const connectionParams = `${this.data.serverUrl}?deviceId=${this.data.deviceId}`
    my.setClipboard({
      text: connectionParams,
    })
    my.showToast({ content: '连接参数已复制', duration: 1500 })
  },

  scanQRCode() {
    my.scan({
      type: 'qr',
      success: (res) => {
        const code = res.code
        console.log('扫码结果:', code)
        const urlParams = parseUrlString(code)

        // 解析 URL 中的参数 url=ws://192.168.0.12:3000
        if (urlParams.url) {
          const decodedUrl = urlParams.url
          console.log('解析后的 URL:', decodedUrl)
          if (decodedUrl.startsWith('ws://') || decodedUrl.startsWith('wss://')) {
            this.setData({ serverUrl: decodedUrl })
            my.showToast({ content: '已自动填入服务器地址', duration: 1500 })
            return
          }
        }
        my.showToast({ content: '无效的二维码格式', duration: 2000 })
      },
      fail: () => {
        my.showToast({ content: '扫码失败，请重试', duration: 2000 })
      },
    })
  },

})
