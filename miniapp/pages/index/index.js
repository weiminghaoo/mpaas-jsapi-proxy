import { Storage } from '../../utils/storage'
import { parseServerUrl } from '../../utils/urlParser'

// 蓝牙解绑类 API 白名单（与 src/bluetooth-apis.ts 的 BLUETOOTH_EVENT_APIS 前缀替换结果保持一致）
// 显式列举而非按 /^off/ 前缀拦截，避免误伤名字以 off 开头的业务自定义 API
const BLUETOOTH_OFF_APIS = [
  'offBluetoothAdapterStateChange',
  'offBluetoothDeviceFound',
  'offBLEConnectionStateChanged',
  'offBLECharacteristicValueChange',
  'offBeaconUpdate',
  'offBeaconServiceChange',
]

Page({
  data: {
    deviceId: '',
    serverUrl: 'ws://192.168.1.100:3000',
    clientUsageSnippet: '',
    bluetoothSnippet: '',
    connectionStatus: '未连接',
    statusClass: 'disconnected',
    isConnected: false,
    scanIcon: '/assets/scan.svg',
    showUsage: false,
    logs: [],
  },

  // ===== 运行日志（最新在前，限量防卡顿） =====
  log(tag, payload) {
    if (!this._logId) {
      this._logId = 0
    }
    this._logId++
    let text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    if (text && text.length > 400) {
      text = text.slice(0, 400) + '…'
    }
    const entry = {
      id: this._logId,
      time: new Date().toTimeString().slice(0, 8),
      tag: tag,
      text: text,
    }
    this.setData({ logs: [entry].concat(this.data.logs).slice(0, 100) })
  },

  clearLogs() {
    this._logId = 0
    this.setData({ logs: [] })
  },

  copyLogs() {
    const lines = this.data.logs
      .slice()
      .reverse()
      .map((item) => item.time + ' [' + item.tag + '] ' + item.text)
      .join('\n')
    my.setClipboard({
      text: lines,
      success: () => my.showToast({ content: '日志已复制', duration: 1500 }),
    })
  },

  // ===== 使用说明 popup =====
  showUsage() {
    this.setData({ showUsage: true })
  },

  hideUsage() {
    this.setData({ showUsage: false })
  },

  stopBubble() {},

  // 模拟器客户端接入代码（自动填入当前服务器地址与设备ID）
  buildClientUsageSnippet(serverUrl, deviceId) {
    return [
      "import MyCallProxy from 'mpaas-jsapi-proxy'",
      '',
      `const proxy = new MyCallProxy('${serverUrl}?deviceId=${deviceId}');`,
      'proxy.init();',
    ].join('\n')
  },

  // 蓝牙代理模式接入代码
  buildBluetoothSnippet(serverUrl, deviceId) {
    return [
      "import MyCallProxy from 'mpaas-jsapi-proxy'",
      '',
      `const proxy = new MyCallProxy('${serverUrl}?deviceId=${deviceId}', { bluetooth: true });`,
      'proxy.init();',
    ].join('\n')
  },

  // 更新服务器地址并同步刷新接入代码
  applyServerUrl(serverUrl) {
    this.setData({
      serverUrl,
      clientUsageSnippet: this.buildClientUsageSnippet(serverUrl, this.data.deviceId),
      bluetoothSnippet: this.buildBluetoothSnippet(serverUrl, this.data.deviceId),
    })
  },

  onLoad() {
    const deviceId = Storage.getDeviceId()
    const cachedServerUrl = Storage.getServerUrl()
    const appQuery = getApp().globalData.query || {}
    let appQueryUrl
    
    //ws:// wss://开头
    if (appQuery.url && (appQuery.url.startsWith('ws://') || appQuery.url.startsWith('wss://'))) {
      console.log('从全局数据中获取的服务器地址:', appQuery.url)
      appQueryUrl = appQuery.url
    }

    const serverUrl = appQueryUrl || cachedServerUrl || this.data.serverUrl
    this.setData({
      deviceId,
      serverUrl,
      clientUsageSnippet: this.buildClientUsageSnippet(serverUrl, deviceId),
      bluetoothSnippet: this.buildBluetoothSnippet(serverUrl, deviceId),
    })
    this.heartbeatTimer = null
    this._isConnecting = false
    this._hasSetupListeners = false
    this.log('初始化', '设备ID: ' + deviceId)

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
      this.log('连接', 'WebSocket 已连接')
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
      this.log('连接', '连接错误')
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
      this.log('连接', '已断开')
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
    this.applyServerUrl(e.detail.value)
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
        this.log('连接', '连接失败: ' + JSON.stringify(err))
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
          this.log('注册', '注册成功')
          my.showToast({ content: '注册成功！', duration: 2000 })
          this.startHeartbeat()
        }
        break

      case 'client_call':
        this.handleApiCall(message)
        break

      case 'error':
        console.error('收到错误消息', message)
        this.log('错误', (message.error && message.error.message) || '发生错误')
        my.showToast({ content: message.error.message || '发生错误', duration: 2000 })
        break

      default:
        console.log('未处理的消息类型', type)
    }
  },

  handleApiCall(message) {
    const { msgId, api, params, proxyMode } = message

    console.log('执行 API 调用:', api, params)
    this.log('调用:' + api, params)

    // 事件订阅类：注册真机监听，多次回发 event
    if (proxyMode === 'event') {
      this.handleEventSubscribe(message)
      return
    }

    // 蓝牙解绑类：泛化 my.call 对监听解绑不生效，必须用具名 API
    if (BLUETOOTH_OFF_APIS.indexOf(api) !== -1 && typeof my[api] === 'function') {
      try {
        my[api]()
      } catch (e) {
        console.error('解绑失败', e)
      }
      this.log('解绑:' + api, '已解绑并回响应')
      this.sendResponse(msgId, { success: true })
      return
    }

    my.call(api, params || {}, (result) => {
      console.log('API 返回结果:', result)
      this.log('响应:' + api, this.stripContainerFields(result))
      this.sendResponse(msgId, result)
    })
  },

  // 订阅事件：先解绑旧监听（幂等，防重连后重复事件），再注册转发
  handleEventSubscribe(message) {
    const { msgId, api } = message
    const offApi = api.replace(/^on/, 'off')
    if (typeof my[offApi] === 'function') {
      try {
        my[offApi]()
      } catch (e) {
        console.error('清理旧监听失败', e)
      }
    }
    const native = my[api]
    if (typeof native !== 'function') {
      console.error('真机不支持事件 API:', api)
      this.log('订阅被拒:' + api, '真机不支持，回报错误')
      // 用 type:'error' 回报（携带 api），不伪装成事件污染业务回调
      this.sendSubscriptionError(msgId, api, 'unsupported api: ' + api)
      return
    }
    native((data) => {
      console.log('事件触发:', api, data)
      this.sendEvent(msgId, api, data)
    })
    this.log('订阅:' + api, '已注册真机监听')
  },

  // 剔除真机容器注入的 NBPageUrl（JSAPI 回调自带，对模拟器端是噪音且泄漏内部 URL）
  stripContainerFields(value) {
    if (value && typeof value === 'object' && 'NBPageUrl' in value) {
      const copy = Object.assign({}, value)
      delete copy.NBPageUrl
      return copy
    }
    return value
  },

  sendEvent(msgId, api, data) {
    const clean = this.stripContainerFields(data)
    this.log('事件:' + api, clean)
    my.sendSocketMessage({
      data: JSON.stringify({
        type: 'event',
        msgId: msgId,
        api: api,
        deviceId: this.data.deviceId,
        timestamp: Date.now(),
        data: clean,
      }),
      fail: (err) => {
        console.error('事件发送失败', err)
      },
    })
  },

  sendSubscriptionError(msgId, api, message) {
    my.sendSocketMessage({
      data: JSON.stringify({
        type: 'error',
        msgId: msgId,
        api: api,
        deviceId: this.data.deviceId,
        timestamp: Date.now(),
        error: { code: 'API_NOT_FOUND', message: message },
      }),
      fail: (err) => {
        console.error('订阅错误上报失败', err)
      },
    })
  },

  sendResponse(msgId, result) {
    my.sendSocketMessage({
      data: JSON.stringify({
        type: 'response',
        msgId: msgId,
        deviceId: this.data.deviceId,
        timestamp: Date.now(),
        result: this.stripContainerFields(result),
      }),
      fail: (err) => {
        console.error('响应发送失败', err)
      },
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

  copyInstallCommand() {
    my.setClipboard({
      text: 'npm install -g mpaas-jsapi-proxy && mpaas-jsapi-proxy',
    })
    my.showToast({ content: '安装启动命令已复制', duration: 1500 })
  },

  copyClientInstall() {
    my.setClipboard({
      text: 'npm install mpaas-jsapi-proxy --save',
    })
    my.showToast({ content: '安装命令已复制', duration: 1500 })
  },

  copyClientUsage() {
    my.setClipboard({
      text: this.data.clientUsageSnippet,
    })
    my.showToast({ content: '接入代码已复制', duration: 1500 })
  },

  // 跳转蓝牙测试台（真机蓝牙调试 + Task 0 spike）
  copyBluetoothSnippet() {
    my.setClipboard({
      text: this.data.bluetoothSnippet,
    })
    my.showToast({ content: '蓝牙模式接入代码已复制', duration: 1500 })
  },

  copyLog(e) {
    const log = e.currentTarget.dataset.log
    my.setClipboard({
      text: log.text,
    })
    my.showToast({ content: '日志已复制', duration: 1500 })
  },

  scanQRCode() {
    my.scan({
      type: 'qr',
      success: (res) => {
        const code = res.code
        console.log('扫码结果:', code)

        // 兼容 xlmpaas://<appId>?url=... 与 url=... 裸参数串
        const serverUrl = parseServerUrl(code)
        if (serverUrl) {
          console.log('解析后的服务器地址:', serverUrl)
          this.applyServerUrl(serverUrl)
          this.log('扫码', serverUrl)
          my.showToast({ content: '已自动填入服务器地址', duration: 1500 })
          return
        }
        this.log('扫码', '无效二维码格式: ' + code)
        my.showToast({ content: '无效的二维码格式', duration: 2000 })
      },
      fail: () => {
        my.showToast({ content: '扫码失败，请重试', duration: 2000 })
      },
    })
  },
})
