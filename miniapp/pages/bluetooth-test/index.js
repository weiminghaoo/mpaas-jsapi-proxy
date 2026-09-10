// 蓝牙测试台：真机蓝牙调试页，同时承担 Task 0 spike 职责——
// 对比「泛化 my.call」与「具名 API」的真实返回结构（error/errorCode 类型、成功哨兵取值），
// 结论回填 docs/superpowers/plans/2026-09-10-bluetooth-proxy-switch.md 的真机联测清单第 0 条。
const MAX_LOGS = 200
const MAX_TEXT_LEN = 600

Page({
  data: {
    deviceId: '',
    serviceId: '',
    characteristicId: '',
    writeValue: '00FF',
    foundCount: 0,
    notifyCount: 0,
    logs: [],
  },

  onLoad() {
    this._logId = 0
    this.log('提示', '测试顺序：开适配器 → 开始搜索 → 连接BLE → 取服务/特征值 → 读写/订阅Notify')
  },

  // ===== 日志 =====
  log(tag, payload) {
    this._logId++
    let text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    if (text.length > MAX_TEXT_LEN) {
      text = text.slice(0, MAX_TEXT_LEN) + '…'
    }
    const entry = {
      id: this._logId,
      time: new Date().toTimeString().slice(0, 8),
      tag: tag,
      text: text,
    }
    // 最新日志插到最前并限制条数，避免长列表渲染过慢
    this.setData({ logs: [entry].concat(this.data.logs).slice(0, MAX_LOGS) })
  },

  clearLogs() {
    this._logId = 0
    this.setData({ logs: [], foundCount: 0, notifyCount: 0 })
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

  toast(content) {
    my.showToast({ content: content, duration: 2000 })
  },

  // ===== Spike：同一 API 两种调用方式各执行一次，对比真实返回 =====
  callBoth(api, params) {
    my.call(api, params || {}, (res) => {
      this.log(api + ' [my.call泛化]', res)
    })
    const named = my[api]
    if (typeof named === 'function') {
      named(
        Object.assign({}, params, {
          success: (res) => this.log(api + ' [具名success]', res),
          fail: (err) => this.log(api + ' [具名fail]', err),
        })
      )
    } else {
      this.log(api + ' [具名]', '容器上不存在该方法')
    }
  },

  spikeOpenAdapter() {
    this.callBoth('openBluetoothAdapter', {})
  },

  spikeAdapterState() {
    this.callBoth('getBluetoothAdapterState', {})
  },

  // ===== 输入 =====
  onDeviceIdInput(e) {
    this.setData({ deviceId: e.detail.value })
  },

  onServiceIdInput(e) {
    this.setData({ serviceId: e.detail.value })
  },

  onCharacteristicIdInput(e) {
    this.setData({ characteristicId: e.detail.value })
  },

  onWriteValueInput(e) {
    this.setData({ writeValue: e.detail.value })
  },

  // ===== 流程测试（具名 API，success/fail 均记录原始对象） =====
  startDiscovery() {
    my.startBluetoothDevicesDiscovery({
      success: (res) => this.log('startDiscovery', res),
      fail: (err) => this.log('startDiscovery fail', err),
    })
  },

  stopDiscovery() {
    my.stopBluetoothDevicesDiscovery({
      success: (res) => this.log('stopDiscovery', res),
      fail: (err) => this.log('stopDiscovery fail', err),
    })
  },

  getBluetoothDevices() {
    my.getBluetoothDevices({
      success: (res) => {
        this.log('getBluetoothDevices', res)
        const first = res && res.devices && res.devices[0]
        if (first && first.deviceId && !this.data.deviceId) {
          this.setData({ deviceId: first.deviceId })
          this.toast('已自动填入首个设备ID')
        }
      },
      fail: (err) => this.log('getBluetoothDevices fail', err),
    })
  },

  connectDevice() {
    const deviceId = this.data.deviceId.trim()
    if (!deviceId) {
      this.toast('请先输入设备ID（可从搜索日志复制）')
      return
    }
    my.connectBLEDevice({
      deviceId: deviceId,
      success: (res) => this.log('connectBLEDevice', res),
      fail: (err) => this.log('connectBLEDevice fail', err),
    })
  },

  disconnectDevice() {
    const deviceId = this.data.deviceId.trim()
    if (!deviceId) {
      this.toast('请先输入设备ID')
      return
    }
    my.disconnectBLEDevice({
      deviceId: deviceId,
      success: (res) => this.log('disconnectBLEDevice', res),
      fail: (err) => this.log('disconnectBLEDevice fail', err),
    })
  },

  getServices() {
    const deviceId = this.data.deviceId.trim()
    if (!deviceId) {
      this.toast('请先输入设备ID')
      return
    }
    my.getBLEDeviceServices({
      deviceId: deviceId,
      success: (res) => {
        this.log('getBLEDeviceServices', res)
        // 自动填入首个 serviceId，减少手工复制
        const first = res && res.services && res.services[0]
        if (first && (first.serviceId || first.uuid)) {
          this.setData({ serviceId: first.serviceId || first.uuid })
          this.toast('已自动填入首个serviceId')
        }
      },
      fail: (err) => this.log('getBLEDeviceServices fail', err),
    })
  },

  getCharacteristics() {
    const deviceId = this.data.deviceId.trim()
    const serviceId = this.data.serviceId.trim()
    if (!deviceId || !serviceId) {
      this.toast('需要设备ID与serviceId')
      return
    }
    my.getBLEDeviceCharacteristics({
      deviceId: deviceId,
      serviceId: serviceId,
      success: (res) => {
        this.log('getBLEDeviceCharacteristics', res)
        // 自动填入首个 characteristicId
        const first = res && res.characteristics && res.characteristics[0]
        if (first && (first.characteristicId || first.uuid)) {
          this.setData({ characteristicId: first.characteristicId || first.uuid })
          this.toast('已自动填入首个characteristicId')
        }
      },
      fail: (err) => this.log('getBLEDeviceCharacteristics fail', err),
    })
  },

  readValue() {
    const p = this.bleParams()
    if (!p) return
    my.readBLECharacteristicValue(
      Object.assign(p, {
        success: (res) => this.log('readBLECharacteristicValue', res),
        fail: (err) => this.log('readBLECharacteristicValue fail', err),
      })
    )
  },

  writeValue() {
    const p = this.bleParams()
    if (!p) return
    my.writeBLECharacteristicValue(
      Object.assign(p, {
        value: this.data.writeValue.trim(),
        success: (res) => this.log('writeBLECharacteristicValue', res),
        fail: (err) => this.log('writeBLECharacteristicValue fail', err),
      })
    )
  },

  notifyOn() {
    const p = this.bleParams()
    if (!p) return
    my.notifyBLECharacteristicValueChange(
      Object.assign(p, {
        state: true,
        success: (res) => this.log('notifyBLECharacteristicValueChange', res),
        fail: (err) => this.log('notifyBLECharacteristicValueChange fail', err),
      })
    )
  },

  bleParams() {
    const deviceId = this.data.deviceId.trim()
    const serviceId = this.data.serviceId.trim()
    const characteristicId = this.data.characteristicId.trim()
    if (!deviceId || !serviceId || !characteristicId) {
      this.toast('需要设备ID、serviceId、characteristicId')
      return null
    }
    return { deviceId: deviceId, serviceId: serviceId, characteristicId: characteristicId }
  },

  // ===== 监听（具名 + 泛化双注册，验证两条链路是否都触发） =====
  listenDeviceFound() {
    my.onBluetoothDeviceFound((res) => {
      this.setData({ foundCount: this.data.foundCount + 1 })
      this.log('onDeviceFound [具名]', res)
    })
    my.call('onBluetoothDeviceFound', {}, (res) => {
      this.setData({ foundCount: this.data.foundCount + 1 })
      this.log('onDeviceFound [my.call]', res)
    })
    this.log('监听', '设备发现监听已注册（具名 + 泛化各一份）')
  },

  listenCharacteristic() {
    my.onBLECharacteristicValueChange((res) => {
      this.setData({ notifyCount: this.data.notifyCount + 1 })
      this.log('onCharValueChange [具名]', res)
    })
    my.call('onBLECharacteristicValueChange', {}, (res) => {
      this.setData({ notifyCount: this.data.notifyCount + 1 })
      this.log('onCharValueChange [my.call]', res)
    })
    this.log('监听', '特征值变化监听已注册（记得先点「订阅Notify」）')
  },

  offAll() {
    const offs = [
      'offBluetoothDeviceFound',
      'offBLECharacteristicValueChange',
      'offBluetoothAdapterStateChange',
      'offBLEConnectionStateChanged',
    ]
    offs.forEach((off) => {
      if (typeof my[off] === 'function') {
        try {
          my[off]()
        } catch (e) {
          this.log(off + ' 异常', e && e.message)
        }
      }
    })
    this.log('解绑', '已解绑全部监听')
  },
})
