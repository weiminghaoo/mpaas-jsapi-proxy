// 模拟器端 my.call 代理客户端
// 通过 WebSocket 将模拟器中的 my.call 调用转发到真机执行
//
// 使用方法：
// import MyCallProxy from 'mpaas-jsapi-proxy';
// const proxy = new MyCallProxy('ws://192.168.1.100:3000?deviceId=device_xxx');
// proxy.init();

/** my.call 回调 */
type CallCallback = (result: any) => void

/** 原始 my.call 函数签名 */
type CallFunction = (
  api: string,
  params: Record<string, unknown>,
  callback?: CallCallback
) => void

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
}

/** 等待响应中的调用 */
interface PendingCall {
  callback: CallCallback
  timestamp: number
}

/** mPaaS 小程序全局对象（仅声明本模块用到的 API） */
declare const my: {
  call: CallFunction
  connectSocket: (options: {
    url: string
    success?: () => void
    fail?: (err: unknown) => void
  }) => void
  onSocketOpen: (callback: () => void) => void
  onSocketMessage: (callback: (res: { data: string }) => void) => void
  onSocketError: (callback: (err: unknown) => void) => void
  onSocketClose: (callback: () => void) => void
  sendSocketMessage: (options: {
    data: string
    success?: () => void
    fail?: (err: unknown) => void
  }) => void
  closeSocket: (options?: Record<string, unknown>) => void
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

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl
  }

  // 初始化代理
  init(): boolean {
    if (typeof my === 'undefined' || typeof my.call !== 'function') {
      console.error('my.call 不存在，无法初始化代理')
      return false
    }

    // 保存原始 my.call
    this.originalMyCall = my.call

    // 劫持 my.call
    const self = this
    my.call = (api, params, callback) => {
      if (self.isConnected) {
        self.proxyCall(api, params, callback)
      } else if (self.isConnecting) {
        // 连接中，等待连接完成
        console.log(`[代理连接中] 等待连接: ${api}`)
        self.waitForConnection().then(() => {
          console.log(`[代理连接中] 连接完成，发送: ${api}`)
          self.proxyCall(api, params, callback)
        })
      } else {
        console.warn('[代理未连接] 使用原始 my.call')
        if (self.originalMyCall) {
          self.originalMyCall(api, params, callback)
        }
      }
    }

    this.connect()
    console.log('[MyCallProxy] ✅ my.call 代理已初始化')
    return true
  }

  // 连接到代理服务器
  connect(): void {
    const deviceId = this.getDeviceId()

    if (!deviceId) {
      console.error('[MyCallProxy] 服务器URL中缺少deviceId参数')
      return
    }

    console.log('[MyCallProxy] 设备ID:', deviceId)
    console.log('[MyCallProxy] 服务器URL:', this.serverUrl)

    const wsUrl = this.buildWebSocketUrl('/ws', { type: 'simulator' })
    console.log('[MyCallProxy] WebSocket URL:', wsUrl)

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
          console.log('[MyCallProxy] WebSocket 连接创建成功')
        },
        fail: (err) => {
          console.error('[MyCallProxy] WebSocket 连接失败', err)
          this.isConnecting = false
          this.isConnected = false
          if (this._rejectConnect) {
            this._rejectConnect(err)
          }
        },
      })

      // 监听连接打开
      my.onSocketOpen(() => {
        console.log('[MyCallProxy] 🔗 已连接到代理服务器')
        this.isConnecting = false
        this.isConnected = true
        if (this._resolveConnect) {
          this._resolveConnect()
        }
      })

      // 监听消息
      my.onSocketMessage((res) => {
        try {
          const message: ProxyMessage = JSON.parse(res.data)
          this.handleMessage(message)
        } catch (error) {
          console.error('[MyCallProxy] 消息解析失败:', error)
        }
      })

      // 监听错误
      my.onSocketError((err) => {
        console.error('[MyCallProxy] WebSocket 错误:', err)
        this.isConnecting = false
        this.isConnected = false
        if (this._rejectConnect) {
          this._rejectConnect(err)
        }
      })

      // 监听关闭
      my.onSocketClose(() => {
        console.warn('[MyCallProxy] WebSocket 连接已关闭')
        this.isConnecting = false
        this.isConnected = false
        this.rejectPendingCalls('连接已断开')
      })
    } catch (error) {
      console.error('[MyCallProxy] 连接失败:', error)
      this.isConnecting = false
      if (this._rejectConnect) {
        this._rejectConnect(error)
      }
    }
  }

  // 代理调用
  proxyCall(api: string, params: Record<string, unknown>, callback?: CallCallback): void {
    const msgId = this.generateMsgId()
    const deviceId = this.getDeviceId()

    if (!deviceId) {
      console.error('[MyCallProxy] 服务器URL中缺少deviceId参数')
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
          console.error('[MyCallProxy] 发送失败:', err)
          this.pendingCalls.delete(msgId)
          this.fallbackToOriginal(api, params, callback)
        },
      })
    } catch (error) {
      console.error('[MyCallProxy] 发送失败:', error)
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
    } else if (type === 'error') {
      const pending = this.pendingCalls.get(msgId)
      if (pending) {
        console.error(`[MyCallProxy] ❌ 错误: ${msgId}`, error)
        pending.callback({ error: error })
        this.pendingCalls.delete(msgId)
      }
    }
  }

  // 回退到原始 my.call
  fallbackToOriginal(api: string, params: Record<string, unknown>, callback?: CallCallback): void {
    console.warn('[MyCallProxy] 回退到原始 my.call')
    if (this.originalMyCall) {
      this.originalMyCall(api, params, callback)
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
    my.closeSocket()
    if (this.originalMyCall) {
      my.call = this.originalMyCall
    }
    this.rejectPendingCalls('代理已销毁')
    console.log('[MyCallProxy] 🔌 my.call 代理已销毁')
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
