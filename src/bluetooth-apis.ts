// 蓝牙相关 API 清单（依据 @mini-types/alipay@3.0.14，实际定义见 @mini-types/my/types/lib.my.d.ts）
// off* 解绑类 API 不单列，由 on* 前缀替换推导（如 onBluetoothDeviceFound → offBluetoothDeviceFound）

/** 一次性调用的蓝牙 API（options 含 success/fail/complete，请求-响应模型） */
export const BLUETOOTH_ONE_SHOT_APIS = [
  // 蓝牙适配器
  'openBluetoothAdapter',
  'closeBluetoothAdapter',
  'getBluetoothAdapterState',
  // 设备发现
  'startBluetoothDevicesDiscovery',
  'stopBluetoothDevicesDiscovery',
  'getBluetoothDevices',
  'getConnectedBluetoothDevices',
  // 配对
  'getBluetoothPairs',
  'makeBluetoothPair',
  'cancelBluetoothPair',
  // BLE 连接与服务发现
  'connectBLEDevice',
  'disconnectBLEDevice',
  'getBLEDeviceServices',
  'getBLEDeviceCharacteristics',
  'getBLEDeviceRSSI',
  'getBLEDeviceStatus',
  'getBLEMTU',
  'setBLEMTU',
  // BLE 读写与特征值订阅
  'readBLECharacteristicValue',
  'writeBLECharacteristicValue',
  'notifyBLECharacteristicValueChange',
  // 权限引导
  'showBLEPermissionGuide',
  // iBeacon
  'startBeaconDiscovery',
  'stopBeaconDiscovery',
  'getBeacons',
] as const

/** 事件订阅类蓝牙 API（回调多次触发，需多播协议） */
export const BLUETOOTH_EVENT_APIS = [
  'onBluetoothAdapterStateChange',
  'onBluetoothDeviceFound',
  'onBLEConnectionStateChanged',
  'onBLECharacteristicValueChange',
  'onBeaconUpdate',
  'onBeaconServiceChange',
] as const
