// 模拟器端 my.call 代理客户端
// 通过 WebSocket 将模拟器中的 my.call 调用转发到真机执行
//
// 使用方法：
// import MyCallProxy from 'mpaas-jsapi-proxy';
// const proxy = new MyCallProxy('ws://192.168.1.100:3000?deviceId=device_xxx');
// proxy.init();

import { BLUETOOTH_ONE_SHOT_APIS, BLUETOOTH_EVENT_APIS } from './bluetooth-apis'
const TAG = '[MyCallProxy]'

/** my.call 回调 */
type CallCallback = (result: any) => void

/** 原始 my.call 函数签名 */
type CallFunction = (api: string, params: Record<string, unknown>, callback?: CallCallback) => void

/** 代理服务器消息 */
interface ProxyMessage {
  type: string
  msgId: string
  deviceId?: string
  timestamp?: number
  api?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string } & Record<string, unknown>
  role?: string
  proxyMode?: string
  data?: unknown
}

/** 等待响应中的调用 */
interface PendingCall {
  callback: CallCallback
  timestamp: number
}

/** mPaaS 小程序全局对象（仅声明本模块用到的 API） */
declare const my: {
  call: CallFunction
  connectSocket: (options: { url: string; success?: () => void; fail?: (err: unknown) => void }) => void
  onSocketOpen: (callback: () => void) => void
  onSocketMessage: (callback: (res: { data: string }) => void) => void
  onSocketError: (callback: (err: unknown) => void) => void
  onSocketClose: (callback: () => void) => void
  sendSocketMessage: (options: { data: string; success?: () => void; fail?: (err: unknown) => void }) => void
  closeSocket: (options?: Record<string, unknown>) => void
}

/** 代理选项 */
export interface MyCallProxyOptions {
  /** 蓝牙代理开关：开启后重写 my 上的蓝牙具名 API 转发真机（不劫持 my.call）；缺省时劫持 my.call 全量代理 */
  bluetooth?: boolean
}

/**
 * 按支付宝约定判定结果成功与否。
 * 关键陷阱：BLE 的 success 回调**自带** error/errorCode 字段，且类型与 fail 不同——
 *   - fail 回调的 `error` 是 **number**（0 表示成功，非 0 失败）
 *   - success 回调的 `error` / `errorCode` 是 **string**（`''` 与 `'0'` 均表示成功）
 * 因此必须按类型判别，不能笼统地用「有 error 即失败」。
 */
function isSuccessResult(result: any): boolean {
  if (!result || typeof result !== 'object') {
    return true
  }
  if (result.success === true) {
    return true
  }
  if (result.success === false) {
    return false
  }
  if (typeof result.error === 'number') {
    return result.error === 0
  }
  if (typeof result.error === 'string') {
    // connectBLEDevice 成功时 error 可能是空串
    return result.error === '' || result.error === '0'
  }
  if (typeof result.errorCode === 'string') {
    // writeBLECharacteristicValue / disconnectBLEDevice 的成功回调走这里
    return result.errorCode === '' || result.errorCode === '0'
  }
  if (result.error !== undefined && result.error !== null) {
    return false
  }
  return true
}

class MyCallProxy {
  private serverUrl: string
  private pendingCalls = new Map<string, PendingCall>() // msgId → { callback, timestamp }
  private isConnected = false
  private isConnecting = false // 连接中状态
  private connectPromise: Promise<void> | null = null // 连接 Promise
  private originalMyCall: CallFunction | null = null
  private msgIdCounter = 0
  private _deviceIdCache: string | null = null // 缓存解析后的 deviceId
  private _resolveConnect: (() => void) | null = null
  private _rejectConnect: ((reason?: unknown) => void) | null = null
  private options: MyCallProxyOptions
  private originalNamedApis = new Map<string, any>() // api → 原始具名函数（还原用）
  private eventListeners = new Map<string, Set<(data: any) => void>>() // api → 本地监听回调
  private subscribedApis = new Set<string>() // 已向真机发过订阅的 api（断线清空，重连补订阅）
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private socketListenersBound = false // my.onSocket* 只绑定一次（可累积注册，重复绑定会导致回调倍数触发）
  private offlineRetryCounts = new Map<string, number>() // api → DEVICE_OFFLINE 连续重试次数（防真机长期不注册时无限循环）

  constructor(serverUrl: string, options: MyCallProxyOptions = {}) {
    this.serverUrl = serverUrl
    this.options = options
  }

  // 初始化代理（兼容把选项写在 init 里：proxy.init({ bluetooth: true })，防止误传被静默忽略）
  init(options?: MyCallProxyOptions): boolean {
    if (options) {
      this.options = Object.assign({}, this.options, options)
    }
    if (typeof my === 'undefined' || typeof my.call !== 'function') {
      console.error('my.call 不存在，无法初始化代理')
      return false
    }

    // 保存原始 my.call
    this.originalMyCall = my.call

    if (this.options.bluetooth) {
      // 蓝牙模式：重写 my 上的蓝牙具名 API，不劫持 my.call
      this.setupBluetoothProxy()
      console.log(TAG, '✅ 蓝牙 API 代理已初始化')
    }

    const self = this
    my.call = (api, params, callback) => {
      if (self.isConnected) {
        self.proxyCall(api, params, callback)
      } else if (self.isConnecting) {
        // 连接中，等待连接完成
        console.log(`[MyCallProxy] [代理连接中] 等待连接: ${api}`)
        self.waitForConnection().then(() => {
          console.log(`[MyCallProxy] [代理连接中] 连接完成，发送: ${api}`)
          self.proxyCall(api, params, callback)
        })
      } else {
        console.warn(TAG, '[代理未连接] 使用原始 my.call')
        if (self.originalMyCall) {
          self.originalMyCall(api, params, callback)
        }
      }
    }

    this.connect()
    console.log(TAG, '✅ my.call 代理已初始化')
    return true
  }

  // 连接到代理服务器
  connect(): void {
    const deviceId = this.getDeviceId()

    if (!deviceId) {
      console.error(TAG, '服务器URL中缺少deviceId参数')
      return
    }

    console.log(TAG, '设备ID:', deviceId)
    console.log(TAG, '服务器URL:', this.serverUrl)

    const wsUrl = this.buildWebSocketUrl('/ws', { type: 'simulator' })
    console.log(TAG, 'WebSocket URL:', wsUrl)

    // 创建连接 Promise
    this.isConnecting = true
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this._resolveConnect = resolve
      this._rejectConnect = reject
    })

    try {
      my.connectSocket({
        url: wsUrl,
        success: () => {
          console.log(TAG, 'WebSocket 连接创建成功')
        },
        fail: (err) => {
          console.error(TAG, 'WebSocket 连接失败', err)
          this.isConnecting = false
          this.isConnected = false
          if (this._rejectConnect) {
            this._rejectConnect(err)
          }
        },
      })

      // 事件监听只绑定一次：my.onSocket* 是可累积注册，重复绑定会让重连后回调倍数触发
      this.bindSocketListeners()
    } catch (error) {
      console.error(TAG, '连接失败:', error)
      this.isConnecting = false
      if (this._rejectConnect) {
        this._rejectConnect(error)
      }
    }
  }

  // 绑定 socket 事件监听（幂等：仅首次调用生效）
  private bindSocketListeners(): void {
    if (this.socketListenersBound) {
      return
    }
    this.socketListenersBound = true

    // 监听连接打开
    my.onSocketOpen(() => {
      console.log(TAG, '🔗 已连接到代理服务器')
      this.isConnecting = false
      this.isConnected = true
      if (this._resolveConnect) {
        this._resolveConnect()
      }
      this.offlineRetryCounts.clear() // 重连成功即重置 DEVICE_OFFLINE 重试计数
      this.sendSimulatorRegister()
      this.resubscribeAllEvents()
      this.startHeartbeat()
    })

    // 监听消息
    my.onSocketMessage((res) => {
      try {
        const message: ProxyMessage = JSON.parse(res.data)
        this.handleMessage(message)
      } catch (error) {
        console.error(TAG, '消息解析失败:', error)
      }
    })

    // 监听错误
    my.onSocketError((err) => {
      console.error(TAG, 'WebSocket 错误:', err)
      this.isConnecting = false
      this.isConnected = false
      if (this._rejectConnect) {
        this._rejectConnect(err)
      }
    })

    // 监听关闭
    my.onSocketClose(() => {
      console.warn(TAG, 'WebSocket 连接已关闭')
      this.isConnecting = false
      this.isConnected = false
      this.stopHeartbeat()
      // 释放等待中的连接 Promise，避免 waitForConnection 永久挂起
      if (this._rejectConnect) {
        this._rejectConnect(new Error('连接已关闭'))
      }
      // 清空订阅标记，重连后由 resubscribeAllEvents 统一补订阅
      this.subscribedApis.clear()
      this.rejectPendingCalls('连接已断开')
    })
  }

  // 代理调用
  proxyCall(api: string, params: Record<string, unknown>, callback?: CallCallback): void {
    const msgId = this.generateMsgId()
    const deviceId = this.getDeviceId()

    if (!deviceId) {
      console.error(TAG, '服务器URL中缺少deviceId参数')
      this.fallbackToOriginal(api, params, callback)
      return
    }

    // 存储回调
    this.pendingCalls.set(msgId, {
      callback: callback || (() => {}),
      timestamp: Date.now(),
    })

    const message: ProxyMessage = {
      type: 'client_call',
      msgId: msgId,
      deviceId: deviceId,
      timestamp: Date.now(),
      api: api,
      params: params || {},
    }

    try {
      my.sendSocketMessage({
        data: JSON.stringify(message),
        success: () => {
          console.log(`[MyCallProxy] 📤 发送: ${api} (msgId: ${msgId})`)
        },
        fail: (err) => {
          console.error(TAG, '发送失败:', err)
          this.pendingCalls.delete(msgId)
          this.fallbackToOriginal(api, params, callback)
        },
      })
    } catch (error) {
      console.error(TAG, '发送失败:', error)
      this.pendingCalls.delete(msgId)
      this.fallbackToOriginal(api, params, callback)
    }
  }

  // 处理响应消息
  handleMessage(message: ProxyMessage): void {
    const { type, msgId, result, error } = message

    if (type === 'response') {
      const pending = this.pendingCalls.get(msgId)
      if (pending) {
        console.log(`[MyCallProxy] 📥 响应: ${msgId}`)
        pending.callback(result)
        this.pendingCalls.delete(msgId)
      } else {
        console.warn(`[MyCallProxy] 未找到对应的请求: ${msgId}`)
      }
    } else if (type === 'event') {
      // 真机多播事件：按 api 名分发给本地监听（不查 pendingCalls、不销毁）
      const { api, data } = message
      const listeners = this.eventListeners.get(api as string)
      if (listeners && listeners.size > 0) {
        console.log(`[MyCallProxy] 📥 事件: ${api}`)
        for (const cb of listeners) {
          try {
            cb(data)
          } catch (e) {
            console.error(`[MyCallProxy] 事件回调执行出错: ${api}`, e)
          }
        }
      }
    } else if (type === 'error') {
      const pending = this.pendingCalls.get(msgId)
      if (pending) {
        console.error(`[MyCallProxy] ❌ 错误: ${msgId}`, error)
        pending.callback({ error: error })
        this.pendingCalls.delete(msgId)
      } else if (message.api) {
        // 事件订阅被拒绝（事件订阅不登记 pendingCalls，只能靠 message.api 匹配）
        const api = message.api as string
        console.error(`[MyCallProxy] ❌ 事件订阅被拒绝: ${api}`, error)
        this.subscribedApis.delete(api)
        // 服务端回 DEVICE_OFFLINE 说明真机当时还没注册（常见于模拟器先连上）：
        // 本地监听还在就 2s 后补订阅；API_NOT_FOUND 是真机确实不支持，不重试，避免死循环
        if ((error as any)?.code === 'DEVICE_OFFLINE' && this.eventListeners.has(api)) {
          const count = (this.offlineRetryCounts.get(api) || 0) + 1
          if (count > 30) {
            // 真机长期未注册：放弃自动重试（约 60s），避免无限循环刷日志
            console.warn(`[MyCallProxy] ⚠️ 订阅重试达上限（30 次）: ${api}，请确认真机小程序已连接后重新订阅`)
            return
          }
          this.offlineRetryCounts.set(api, count)
          setTimeout(() => this.ensureSubscribed(api), 2000)
        }
      }
    }
  }

  // 回退到原始 my.call
  fallbackToOriginal(api: string, params: Record<string, unknown>, callback?: CallCallback): void {
    console.warn(TAG, '回退到原始 my.call')
    if (this.originalMyCall) {
      this.originalMyCall(api, params, callback)
    }
  }

  // ===== 蓝牙 API 代理（bluetooth: true 时启用） =====

  // 重写 my 上的蓝牙具名 API
  private setupBluetoothProxy(): void {
    for (const api of BLUETOOTH_ONE_SHOT_APIS) {
      this.overrideNamedApi(api)
    }
    for (const api of BLUETOOTH_EVENT_APIS) {
      this.overrideEventApi(api)
      this.overrideOffApi(api.replace(/^on/, 'off'))
    }
  }

  // 重写一次性调用 API：拆出 success/fail/complete，走既有 client_call/response 通道
  private overrideNamedApi(api: string): void {
    this.originalNamedApis.set(api, (my as any)[api])
    const self = this
    ;(my as any)[api] = (options: Record<string, any>) => {
      self.proxyNamedCall(api, options)
    }
  }

  private proxyNamedCall(api: string, options: Record<string, any>): void {
    const { success, fail, complete, ...params } = options || {}
    const routedCallback: CallCallback = (result: any) => {
      if (isSuccessResult(result)) {
        if (typeof success === 'function') {
          success(result)
        }
      } else if (typeof fail === 'function') {
        fail(result)
      }
      if (typeof complete === 'function') {
        complete(result)
      }
    }

    if (this.isConnected) {
      this.proxyCall(api, params, routedCallback)
    } else if (this.isConnecting) {
      this.waitForConnection()
        .then(() => this.proxyCall(api, params, routedCallback))
        .catch(() => this.fallbackNamedApi(api, options))
    } else {
      this.fallbackNamedApi(api, options)
    }
  }

  // 回退本地具名 API；本地也没有时触发 fail
  private fallbackNamedApi(api: string, options: Record<string, any>): void {
    const original = this.originalNamedApis.get(api)
    if (typeof original === 'function') {
      console.warn(`[MyCallProxy] 代理未连接，回退本地执行: ${api}`)
      original(options)
    } else if (options && typeof options.fail === 'function') {
      options.fail({ error: 4, errorMessage: `代理未连接且本地不支持: ${api}` })
    }
  }

  // 重写事件订阅 API：回调存本地，由 ensureSubscribed 保证订阅发出
  private overrideEventApi(api: string): void {
    this.originalNamedApis.set(api, (my as any)[api])
    const self = this
    // 兼容两种监听写法：my.onXxx(cb) 与 my.onXxx({ success: cb })
    ;(my as any)[api] = (arg: ((data: any) => void) | { success?: (data: any) => void }) => {
      const listener = typeof arg === 'function' ? arg : arg && typeof arg.success === 'function' ? arg.success : null
      if (!listener) {
        console.warn(`[MyCallProxy] ${api} 参数既不是函数也不是含 success 的对象，调用被忽略`)
        return
      }
      let listeners = self.eventListeners.get(api)
      if (!listeners) {
        listeners = new Set()
        self.eventListeners.set(api, listeners)
      }
      listeners.add(listener)
      self.ensureSubscribed(api)
    }
  }

  // 保证订阅发出：已连接直接发；未连接触发重连，连接成功后统一补订阅（不回退本地实现，避免同回调双触发）
  private ensureSubscribed(api: string): void {
    if (this.subscribedApis.has(api)) {
      return
    }
    if (this.isConnected) {
      this.subscribedApis.add(api)
      this.sendEventSubscribe(api)
      return
    }
    if (!this.isConnecting) {
      console.warn(`[MyCallProxy] 代理未连接，尝试重连以订阅: ${api}`)
      try {
        this.connect()
      } catch (e) {
        console.error(`[MyCallProxy] 重连失败: ${api}`, e)
        return
      }
    }
    this.waitForConnection()
      .then(() => {
        if (this.subscribedApis.has(api)) {
          return
        }
        this.subscribedApis.add(api)
        this.sendEventSubscribe(api)
      })
      .catch(() => console.error(`[MyCallProxy] 事件订阅失败（连接失败）: ${api}`))
  }

  // 重连/首次连接成功后，为所有仍存活的本地监听补发订阅（真机侧 off-before-on 幂等）
  private resubscribeAllEvents(): void {
    for (const api of this.eventListeners.keys()) {
      if (!this.subscribedApis.has(api)) {
        this.subscribedApis.add(api)
        this.sendEventSubscribe(api)
      }
    }
  }

  private sendEventSubscribe(api: string): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      return
    }
    const message: ProxyMessage = {
      type: 'client_call',
      msgId: this.generateMsgId(),
      deviceId: deviceId,
      timestamp: Date.now(),
      api: api,
      params: {},
      proxyMode: 'event',
    }
    my.sendSocketMessage({
      data: JSON.stringify(message),
      success: () => {
        console.log(`[MyCallProxy] 📤 订阅: ${api} (事件模式)`)
      },
      fail: (err) => {
        this.subscribedApis.delete(api)
        console.error(`[MyCallProxy] 事件订阅发送失败: ${api}`, err)
      },
    })
  }

  // 重写解绑 API：清空本地该 api 的全部监听（支付宝 off 语义即全量解绑），并转发真机解绑
  private overrideOffApi(api: string): void {
    this.originalNamedApis.set(api, (my as any)[api])
    const self = this
    ;(my as any)[api] = () => {
      const onApi = api.replace(/^off/, 'on')
      self.eventListeners.delete(onApi)
      self.subscribedApis.delete(onApi)

      if (self.isConnected) {
        self.proxyCall(api, {}, () => {})
      } else if (self.isConnecting) {
        self
          .waitForConnection()
          .then(() => self.proxyCall(api, {}, () => {}))
          .catch(() => {})
      } else if (typeof self.originalNamedApis.get(api) === 'function') {
        ;(self.originalNamedApis.get(api) as any)()
      }
    }
  }

  // 向服务器注册模拟器连接（服务端用于事件推送寻址）
  private sendSimulatorRegister(): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      return
    }
    my.sendSocketMessage({
      data: JSON.stringify({
        type: 'register',
        msgId: 'msg_register_' + Date.now(),
        deviceId: deviceId,
        role: 'simulator',
        timestamp: Date.now(),
      }),
      fail: (err) => console.error(TAG, '模拟器注册发送失败:', err),
    })
  }

  // 心跳：与服务端 60s 超时配套，防止注册后的模拟器连接被判定超时
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      const deviceId = this.getDeviceId()
      if (!deviceId) {
        return
      }
      my.sendSocketMessage({
        data: JSON.stringify({
          type: 'heartbeat',
          msgId: 'heartbeat_' + Date.now(),
          deviceId: deviceId,
          timestamp: Date.now(),
        }),
      })
    }, 30000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  // 拒绝所有等待中的调用
  rejectPendingCalls(reason: string): void {
    for (const [msgId, pending] of this.pendingCalls) {
      pending.callback({ error: { message: reason, msgId: msgId } })
    }
    this.pendingCalls.clear()
  }

  // 生成消息ID
  generateMsgId(): string {
    return 'msg_' + Date.now() + '_' + ++this.msgIdCounter
  }

  // 获取设备ID（带缓存）
  getDeviceId(): string | null {
    if (this._deviceIdCache) {
      return this._deviceIdCache
    }

    const match = this.serverUrl.match(/[?&]deviceId=([^&]+)/)
    this._deviceIdCache = match ? match[1] : null
    return this._deviceIdCache
  }

  // 构建带路径和参数的 WebSocket URL
  buildWebSocketUrl(path: string, extraParams: Record<string, string> = {}): string {
    const urlMatch = this.serverUrl.match(/^(https?:\/\/|wss?:\/\/)([^\\/?]+)(.*)$/)
    if (!urlMatch) {
      return this.serverUrl
    }

    const [, protocol, host, rest] = urlMatch

    const existingParams: Record<string, string> = {}
    const queryMatch = rest.match(/\?([^#]*)/)
    if (queryMatch) {
      const queryString = queryMatch[1]
      queryString.split('&').forEach((param) => {
        const [key, value] = param.split('=')
        if (key) {
          existingParams[key] = value || ''
        }
      })
    }

    const allParams = { ...existingParams, ...extraParams }
    const queryString = Object.entries(allParams)
      .map(([k, v]) => `${k}=${v}`)
      .join('&')

    return `${protocol}${host}${path}?${queryString}`
  }

  // 等待连接完成
  waitForConnection(): Promise<void> {
    if (!this.connectPromise) {
      return Promise.reject(new Error('连接未初始化'))
    }
    return this.connectPromise
  }

  // 销毁代理
  destroy(): void {
    this.isConnected = false
    this.isConnecting = false
    this.stopHeartbeat()
    my.closeSocket()
    if (this.originalMyCall) {
      my.call = this.originalMyCall
    }
    // 还原被重写的蓝牙具名 API
    for (const [api, original] of this.originalNamedApis) {
      if (typeof original === 'function') {
        ;(my as any)[api] = original
      } else {
        delete (my as any)[api]
      }
    }
    this.originalNamedApis.clear()
    this.eventListeners.clear()
    this.subscribedApis.clear()
    this.rejectPendingCalls('代理已销毁')
    console.log(TAG, '🔌 my.call 代理已销毁')
  }

  // 获取连接状态
  getStatus(): { isConnected: boolean; pending_calls: number; serverUrl: string } {
    return {
      isConnected: this.isConnected,
      pending_calls: this.pendingCalls.size,
      serverUrl: this.serverUrl,
    }
  }
}

export default MyCallProxy
