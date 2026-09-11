# 蓝牙 API 代理开关 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `MyCallProxy` 增加 `bluetooth` 开关：开启后重写 `my` 上的蓝牙具名 API（`my.openBluetoothAdapter({success, fail})` 等）转发到真机执行，监听类 API 由真机多播事件回模拟器；关闭时保持现状。

**Architecture:** 三段链路 `模拟器客户端 ←→ WebSocket 服务器 ←→ 真机 miniapp`。一次性 API 复用现有 `client_call`/`response` 协议，success/fail 由客户端**按类型**判别支付宝约定（`fail` 回调的 `error` 是 number，`0` 成功；BLE `success` 回调自带的 `error`/`errorCode` 是 string，`''` 与 `'0'` 均为成功哨兵）；监听类 API 新增 `proxyMode:'event'` 订阅标记与 `type:'event'` 多播消息，服务端按 deviceId 将事件推送到该设备的模拟器连接（补齐 `Device.simulatorWS` 的注册链路）；订阅被拒经 `type:'error'`（带 `api`）按 deviceId 回到模拟器——`API_NOT_FOUND` 由真机发出；真机未注册时由**服务端**以 `DEVICE_OFFLINE` 拒绝，客户端 2s 后自动补订阅（上限 30 次，防真机长期不注册时无限循环刷日志）。开关打开时**不劫持 `my.call`**，业务自定义 JSAPI 零影响。

**Tech Stack:** TypeScript + Vite（构建）、ws（服务端）、小程序原生 JS（miniapp）、@mini-types/alipay（API 清单依据，devDependency，已安装）

**Spec:** bounded 路径会话内设计确认（无独立 spec 文件）+ 外部 review 修订。核心决策：
- **Task 0 是阻塞性的真机 spike**：唯一未经验证的前提是「真机上 `my.call` 能调起蓝牙原生能力」。冒烟测试无法证伪它（那里的「真机」是自建 mock），故先做 Task 0，其结论决定 Task 3 是否改用具名 API + `__ok` 归一化
- `bluetooth: true` = 仅代理蓝牙 API，其余 API 保持本地；不传 = 现状（劫持 `my.call` 全量代理）
- 一次性 API 原路返回；监听类「真机 → 服务端 → 推送模拟器」
- 事件按 **api 名**在客户端分发；断线清空 `subscribedApis`，重连后 `resubscribeAllEvents` 自动补订阅（真机侧 off-before-on 幂等，不产生重复监听）
- API 清单以 `@mini-types/alipay@3.0.14`（实际定义在 `@mini-types/my`）为准，含 BLE + 经典蓝牙 + iBeacon；`off*` 由 `on*` 前缀替换推导；miniapp 侧使用显式 off 白名单（不按前缀拦截，防误伤 `offlineXxx` 类业务 API）
- 支付宝 BLE `value` 为 16 进制字符串（非 ArrayBuffer），JSON 序列化安全，无需二进制编码
- `off*` 简化为全量解绑（忽略可选 cb 参数）
- 事件订阅在服务端**不登记 pendingCalls**（永无 response，防句柄泄漏）；订阅被拒走服务端新增的 `error` 路由分支，且 `sendError` 增加可选 `api` 字段——否则「模拟器先连上、真机尚未注册」时回包的 `DEVICE_OFFLINE` 不带 api，客户端既无 pending 也无 api 可匹配，会导致该 api 的订阅**永久静默失效**，且订阅标记不会回滚
- 未连接时事件订阅 = 仅存本地监听 + 触发重连，连接成功后统一补订阅（不回退本地模拟器实现，避免同回调双触发）；订阅被 `DEVICE_OFFLINE` 拒绝且本地仍有监听时 2s 后自动补订阅（**上限 30 次≈60s，重连时清零**；真机长期不注册则放弃并 warn 一次性提示），被 `API_NOT_FOUND` 拒绝（真机确实不支持）则不重试
- `onSocketClose` 补 reject connectPromise（修复既有缺陷：等待中的 `waitForConnection` 永久挂起）
- socket 事件监听只在首次 `connect()` 时绑定一次：`my.onSocket*` 是**可累积注册**，重复绑定会让重连后单条消息触发多次业务回调（`miniapp/pages/index/index.js:65` 的 `_hasSetupListeners` 守卫是同一坑的既有先例）

## Global Constraints

- 工作分支：`feature/bluetooth-proxy`（从 main 切出，本地分支即可，不推远程）
- 提交格式：`<type>(scope): <summary>`，summary 中文、动词开头、≤50 字、不加句号
- 不新增运行时依赖；devDependencies 仅使用已安装的 `@mini-types/alipay`（其依赖变更在 Task 1 单独提交，不与 docs 混提）
- 代码风格：`src/index.ts` 无分号风格；`src/server/*.ts` 分号风格；`miniapp/` JS 无分号风格；注释简体中文
- 验证命令：`pnpm type-check`、`pnpm build`；服务端进程内启动用 `new ProxyServer({ port })`，冒烟端口用 7598/7599（默认端口 7521，避免占用）
- `src/index.ts` 将超过 300 行软上限（已有单文件客户端，拆分会暴露连接内部状态；豁免理由写入提交说明）
- 不得虚构验证结果：每步验证命令必须真实执行并核对输出

---

### Task 0: 真机 spike —— 验证 `my.call` 对蓝牙 API 的真实返回结构（阻塞项，先做）

**为什么必须做：** 整条链路只有一个从未验证的前提——真机上 `my.call('openBluetoothAdapter', params, cb)` 能调起原生 BLE 并返回预期结构。Task 2 的冒烟测试**无法证伪**这个前提：那里的「真机」是脚本自己 mock 的 WebSocket 端，返回什么完全由测试决定，`{success:true, mocked:true}` 这类桩数据必然让断言通过。计划自己也间接承认了同类风险——`off*` 之所以改用具名 API，理由正是「泛化 `my.call` 对监听解绑不生效」。若前提不成立，Task 2 / Task 3 全部要返工。

**Files:** 无（在真机 miniapp 中临时执行，不产生仓库改动）

- [ ] **Step 1: 在真机小程序里执行 spike**

在真机小程序的临时页面或调试控制台中运行：

```js
// spike：比较「泛化 my.call」与「具名 API」对蓝牙能力的调用结果
my.openBluetoothAdapter({
  success: (res) => console.log('SPIKE 具名 openBluetoothAdapter success', JSON.stringify(res)),
  fail: (err) => console.log('SPIKE 具名 openBluetoothAdapter fail', JSON.stringify(err)),
})

my.call('openBluetoothAdapter', {}, (res) => {
  console.log('SPIKE my.call openBluetoothAdapter', JSON.stringify(res))
})

my.call('getBluetoothAdapterState', {}, (res) => {
  console.log('SPIKE my.call getBluetoothAdapterState', JSON.stringify(res))
})

// 真机可能不支持的 API：观察是抛错、进 fail，还是静默无响应
try {
  my.call('onBeaconServiceChange', {}, (res) => {
    console.log('SPIKE my.call onBeaconServiceChange', JSON.stringify(res))
  })
} catch (e) {
  console.log('SPIKE onBeaconServiceChange threw', e && e.message)
}
```

- [ ] **Step 2: 记录三个结论（决定后续实现）**

1. **`my.call(api, params, cb)` 能否调起蓝牙原生能力？**
   - 能 → Task 3 保持现有「一次性 API 走泛化 `my.call`」的设计
   - 不能 → 按 Step 3 的兜底方案改造 miniapp 侧
2. **success 回调里 `error` / `errorCode` 的类型与取值是什么？**
   - 用于确认 Task 2 Step 3 的 `isSuccessResult` 分支覆盖完整（`number` 的 `0`、`string` 的 `''` 与 `'0'` 是否能覆盖真实返回）
3. **真机不支持某 API 时的表现？**（抛异常 / 回调返回 error / 完全静默）
   - 决定订阅被拒时能否被 `type:'error'` 的 `API_NOT_FOUND` 路径捕获；若表现为「静默无响应」，则订阅会停留在「已标记但真机未注册监听」的不一致状态，需要在计划里补一条订阅超时兜底

- [ ] **Step 3: 兜底方案（仅当 Step 2 结论 1 为「不能」时执行）**

miniapp 侧蓝牙一次性 API 改用具名调用 + 显式成败标记，彻底消除对支付宝 `error` 语义的猜测：

```js
// miniapp：蓝牙一次性 API 用具名调用，显式标注 __ok
const isBleOneShot = BLUETOOTH_ONE_SHOT_APIS.indexOf(api) !== -1
if (isBleOneShot && typeof my[api] === 'function') {
  my[api](
    Object.assign({}, params, {
      success: (d) => this.sendResponse(msgId, Object.assign({}, d, { __ok: true })),
      fail: (e) => this.sendResponse(msgId, Object.assign({}, e, { __ok: false })),
    })
  )
  return
}
```

同时客户端 `isSuccessResult` 优先读 `result.__ok`，读不到再回退到现有类型判别。此方案需要把 `BLUETOOTH_ONE_SHOT_APIS` 同步到 miniapp 侧（或在 miniapp 内重复一份常量）。

- [ ] **Step 4: 把结论回填到本计划的真机联测清单第 0 条**

---

### Task 1: 服务端支持模拟器注册、事件推送与订阅错误回报

**Files:**
- Modify: `src/server/device-manager.ts`
- Modify: `src/server/message-router.ts`
- Test: `/tmp/verify-server-event.mts`（临时脚本，不提交）

**Interfaces:**
- Consumes: 现有 `DeviceManager.registerDevice / getDevice / devicesMap`、`MessageRouter.handleMessage` 的 switch 分发
- Produces:
  - `DeviceManager.registerSimulator(deviceId: string, ws: WebSocket): void`
  - `MessageRouter` 消息协议：`register` 支持 `role:'simulator'`；`event` 按 `deviceId` 推送到 `device.simulatorWS`（校验 `readyState === 1`，即 `WebSocket.OPEN`）；`client_call` 且 `proxyMode:'event'` **不登记 pendingCalls**；真机上行的 `type:'error'`（带 `deviceId`）按 deviceId 转发给模拟器；`sendError` 增加可选 `api` 参数，调用方在 `handleClientCall` 三处错误回包处一并传入 `message.api`
  - Task 2 的客户端与 Task 3 的 miniapp 依赖以上协议行为

- [ ] **Step 1: 创建特性分支并单独提交依赖变更**

```bash
cd /Volumes/KIOXIA/workspace/xiaolian/100_miniapp/jsapi_proxy
git checkout -b feature/bluetooth-proxy
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): 添加 @mini-types/alipay 类型开发依赖"
```

（`@mini-types/alipay` 仅作 API 清单依据，运行时零引用，故为 devDependency。）

- [ ] **Step 2: 编写服务端验证脚本（先写验证）**

创建 `/tmp/verify-server-event.mts`：

```ts
// 服务端模拟器注册 + 事件推送 + 订阅错误回报验证脚本（临时，不提交）
import assert from 'node:assert'
import { createRequire } from 'node:module'

const PROJECT = '/Volumes/KIOXIA/workspace/xiaolian/100_miniapp/jsapi_proxy'
const require = createRequire(PROJECT + '/package.json')
const WebSocket = require('ws')
const { ProxyServer } = await import(PROJECT + '/src/server/server.ts')

const PORT = 7598
const DEVICE_ID = 'device_srv_test'
const server = new ProxyServer({ port: PORT })
server.start()
await new Promise((r) => setTimeout(r, 300))

// 模拟真机小程序
const phone = new WebSocket(`ws://127.0.0.1:${PORT}/ws?type=miniapp`)
await new Promise((r: any) => phone.on('open', r))
phone.send(JSON.stringify({ type: 'register', msgId: 'r1', deviceId: DEVICE_ID, deviceInfo: {} }))

// 模拟模拟器
const sim = new WebSocket(`ws://127.0.0.1:${PORT}/ws?type=simulator`)
const events: any[] = []
const errors: any[] = []
let registerAck: any = null
sim.on('message', (raw: Buffer) => {
  const msg = JSON.parse(raw.toString())
  if (msg.type === 'event') events.push(msg)
  if (msg.type === 'error') errors.push(msg)
  if (msg.type === 'register') registerAck = msg
})
await new Promise((r: any) => sim.on('open', r))
sim.send(JSON.stringify({ type: 'register', msgId: 'r2', deviceId: DEVICE_ID, role: 'simulator' }))
await new Promise((r) => setTimeout(r, 200))

assert.ok(registerAck && registerAck.success === true, '模拟器应收到注册成功响应')

// 真机发事件 → 应推送到模拟器
phone.send(JSON.stringify({
  type: 'event', msgId: 'sub_1', api: 'onBluetoothDeviceFound',
  deviceId: DEVICE_ID, data: { devices: [{ name: 'd1' }] },
}))
await new Promise((r) => setTimeout(r, 200))
assert.strictEqual(events.length, 1, '模拟器应收到 1 条事件')
assert.strictEqual(events[0].api, 'onBluetoothDeviceFound')

// 真机上报订阅错误 → 应按 deviceId 推送到模拟器
phone.send(JSON.stringify({
  type: 'error', msgId: 'sub_err', api: 'onBeaconUpdate', deviceId: DEVICE_ID,
  error: { code: 'API_NOT_FOUND', message: 'mock unsupported' },
}))
await new Promise((r) => setTimeout(r, 200))
assert.strictEqual(errors.length, 1, '模拟器应收到 1 条订阅错误')
assert.strictEqual(errors[0].error.code, 'API_NOT_FOUND')

// 未知设备的事件：不推送、不报错
phone.send(JSON.stringify({ type: 'event', msgId: 'sub_2', api: 'onBeaconUpdate', deviceId: 'device_no_such', data: {} }))
await new Promise((r) => setTimeout(r, 200))
assert.strictEqual(events.length, 1, '未知设备的事件不应推送给已注册模拟器')

// 真机未注册时模拟器发订阅：错误回包必须带 api 字段
// （客户端事件订阅不登记 pendingCalls，只能靠 message.api 匹配；不带 api 则订阅永久静默失效）
sim.send(JSON.stringify({
  type: 'client_call', msgId: 'sub_offline', api: 'onBeaconUpdate',
  deviceId: 'device_not_registered', proxyMode: 'event',
}))
await new Promise((r) => setTimeout(r, 200))
assert.strictEqual(errors.length, 2, '未注册设备的订阅应收到错误回包')
assert.strictEqual(errors[1].api, 'onBeaconUpdate', 'DEVICE_OFFLINE 错误回包应携带 api 字段')

console.log('🎉 服务端事件推送验证通过')
server.stop()
process.exit(0)
```

- [ ] **Step 3: 运行脚本确认失败**

```bash
cd /Volumes/KIOXIA/workspace/xiaolian/100_miniapp/jsapi_proxy && npx tsx /tmp/verify-server-event.mts
```

预期：FAIL。注意失败点：`registerAck.success` 断言**会通过**（现有 `handleRegister` 无条件回 `success:true`，只是把模拟器误注册成了真机）；**真正先失败的是 `assert.strictEqual(events.length, 1)`**——当前服务端没有 `event` 分支，事件落入 `UNKNOWN_MESSAGE_TYPE` 被回给真机，模拟器收不到。

- [ ] **Step 4: 修改 device-manager.ts**

在 `registerDevice` 方法之后新增：

```ts
  // 注册模拟器连接（role: simulator，服务端用于事件推送寻址）
  registerSimulator(deviceId: string, ws: WebSocket): void {
    let device = this.devices.get(deviceId);
    if (!device) {
      device = { ws: null, simulatorWS: null, deviceInfo: {}, lastHeartbeat: Date.now() };
      this.devices.set(deviceId, device);
    }
    device.simulatorWS = ws;
    device.lastHeartbeat = Date.now();
    Utils.log(`模拟器注册成功: ${deviceId}`, 'success');
  }
```

将 `disconnect` 方法整体替换为（只清对应连接，两者都空才删条目，避免真机重连后丢失模拟器连接）：

```ts
  // 断开连接（区分真机与模拟器，只清对应连接）
  disconnect(ws: WebSocket): boolean {
    for (const [deviceId, device] of this.devices) {
      if (device.ws === ws) {
        device.ws = null;
        if (!device.simulatorWS) {
          this.devices.delete(deviceId);
        }
        Utils.log(`设备断开连接: ${deviceId}`, 'warn');
        return true;
      }
      if (device.simulatorWS === ws) {
        device.simulatorWS = null;
        if (!device.ws) {
          this.devices.delete(deviceId);
        }
        Utils.log(`模拟器断开连接: ${deviceId}`, 'warn');
        return true;
      }
    }
    return false;
  }
```

- [ ] **Step 5: 修改 message-router.ts**

5a. `Message` 接口增加字段（在 `success?: boolean;` 附近）：

```ts
  role?: string;
  proxyMode?: string;
  data?: any;
```

5b. `handleMessage` 的 switch 新增两个分支（在 `case 'heartbeat':` 之前）：

```ts
      case 'event':
        this.handleEvent(message);
        break;
      case 'error':
        this.handlePhoneError(message);
        break;
```

5c. `handleRegister` 中，`this.deviceManager.registerDevice(deviceId, ws, deviceInfo || {});` 一行替换为：

```ts
    if (message.role === 'simulator') {
      this.deviceManager.registerSimulator(deviceId, ws);
    } else {
      this.deviceManager.registerDevice(deviceId, ws, deviceInfo || {});
    }
```

5d. `handleClientCall` 中，登记 pendingCalls 的语句块（`// 记录 msgId → ws 映射，用于响应时回传` 注释及其后的 `this.pendingCalls.set(...)` 整块）替换为：

```ts
    // 事件订阅永无 response，不登记 pendingCalls（避免句柄泄漏）
    if (message.proxyMode !== 'event') {
      this.pendingCalls.set(msgId!, {
        ws,
        deviceId,
        timestamp: Date.now()
      });
    }
```

5e. 新增两个方法（放在 `handleResponse` 之后）：

```ts
  // 处理真机事件：按 deviceId 推送到该设备的模拟器连接
  handleEvent(message: Message): void {
    const { deviceId, api } = message;

    if (!deviceId) {
      return;
    }

    const device = this.deviceManager.getDevice(deviceId);
    if (!device || !device.simulatorWS || device.simulatorWS.readyState !== 1) {
      // readyState !== 1 即 WebSocket.OPEN
      Utils.log(`事件无处推送: ${api} @ ${deviceId}`, 'warn');
      return;
    }

    try {
      device.simulatorWS.send(JSON.stringify(message));
      Utils.log(`推送事件: ${api} → 模拟器 (${deviceId})`, 'info');
    } catch (error) {
      Utils.log(`事件推送失败: ${(error as Error).message}`, 'error');
    }
  }

  // 处理真机上报的错误（如事件订阅被拒绝）：按 deviceId 转发给模拟器
  handlePhoneError(message: Message): void {
    const { deviceId } = message;

    if (!deviceId) {
      return;
    }

    const device = this.deviceManager.getDevice(deviceId);
    if (!device || !device.simulatorWS || device.simulatorWS.readyState !== 1) {
      // readyState !== 1 即 WebSocket.OPEN
      return;
    }

    try {
      device.simulatorWS.send(JSON.stringify(message));
    } catch (error) {
      Utils.log(`错误转发失败: ${(error as Error).message}`, 'error');
    }
  }
```

5f. `handleClientCall` 的三处错误回包补上 `api`，并给 `sendError` 增加可选 `api` 参数。

`handleClientCall` 中：

```ts
    if (!deviceId) {
      this.sendError(ws, msgId!, 'INVALID_DEVICE_ID', '设备ID不能为空', api);
      return;
    }
```

```ts
    const device = this.deviceManager.getDevice(deviceId);
    if (!device || !device.ws) {
      this.pendingCalls.delete(msgId!);
      this.sendError(ws, msgId!, 'DEVICE_OFFLINE', '代理小程序未连接', api);
      return;
    }
```

```ts
    } catch (error) {
      this.pendingCalls.delete(msgId!);
      this.sendError(ws, msgId!, 'SEND_FAILED', `发送失败: ${(error as Error).message}`, api);
    }
```

`sendError` 整体替换为（新增可选 `api`；`JSON.stringify` 会忽略值为 `undefined` 的键，不影响既有调用）：

```ts
  // 发送错误消息（api 可选：事件订阅错误据此回传，客户端无 pendingCalls 也能定位是哪条订阅）
  sendError(ws: WebSocket, msgId: string | undefined, code: string, message: string, api?: string): void {
    if (ws && ws.readyState === 1) {
      // WebSocket.OPEN
      ws.send(
        JSON.stringify({
          type: 'error',
          msgId: msgId,
          api: api,
          timestamp: Date.now(),
          error: {
            code: code,
            message: message,
          },
        }),
      );
    }
  }
```

- [ ] **Step 6: 运行脚本确认通过**

```bash
cd /Volumes/KIOXIA/workspace/xiaolian/100_miniapp/jsapi_proxy && npx tsx /tmp/verify-server-event.mts
```

预期：输出 `🎉 服务端事件推送验证通过`，退出码 0。

- [ ] **Step 7: 类型检查**

```bash
cd /Volumes/KIOXIA/workspace/xiaolian/100_miniapp/jsapi_proxy && pnpm type-check
```

预期：无错误退出。

- [ ] **Step 8: 提交**

```bash
cd /Volumes/KIOXIA/workspace/xiaolian/100_miniapp/jsapi_proxy
git add src/server/device-manager.ts src/server/message-router.ts
git commit -m "feat(server): 支持模拟器注册与蓝牙事件推送"
```

---

### Task 2: 蓝牙 API 清单与客户端重写层

**Files:**
- Create: `src/bluetooth-apis.ts`
- Modify: `src/index.ts`
- Test: `/tmp/smoke-bluetooth.mts`（临时脚本，不提交）

**Interfaces:**
- Consumes: Task 1 的服务端协议（`register` 支持 `role:'simulator'`；`event`/`error` 按 deviceId 推送；事件订阅不登记 pendingCalls）；现有 `MyCallProxy` 私有方法 `proxyCall / waitForConnection / getDeviceId / generateMsgId`
- Produces:
  - `src/bluetooth-apis.ts` 导出 `BLUETOOTH_ONE_SHOT_APIS: string[]`（25 个）、`BLUETOOTH_EVENT_APIS: string[]`（6 个 `on*`）
  - `src/index.ts` 导出 `MyCallProxyOptions`（`{ bluetooth?: boolean }`）；构造器签名 `new MyCallProxy(serverUrl: string, options?: MyCallProxyOptions)`
  - 行为约定：socket 事件监听仅在首次 `connect()` 时绑定一次（`my.onSocket*` 可累积注册，重复绑定会让重连后回调按倍数触发）；断线清空订阅标记并在重连后补订阅；订阅被拒（`type:'error'` 带 `api`）解除订阅标记——`DEVICE_OFFLINE` 且本地仍有监听时 2s 后补一次订阅，`API_NOT_FOUND` 不重试

- [ ] **Step 1: 对照 @mini-types/my 校验 API 清单（先写清单依据）**

```bash
cd /Volumes/KIOXIA/workspace/xiaolian/100_miniapp/jsapi_proxy
DTS=node_modules/@mini-types/my/types/lib.my.d.ts
for api in openBluetoothAdapter closeBluetoothAdapter getBluetoothAdapterState \
  startBluetoothDevicesDiscovery stopBluetoothDevicesDiscovery getBluetoothDevices \
  getConnectedBluetoothDevices getBluetoothPairs makeBluetoothPair cancelBluetoothPair \
  connectBLEDevice disconnectBLEDevice getBLEDeviceServices getBLEDeviceCharacteristics \
  getBLEDeviceRSSI getBLEDeviceStatus getBLEMTU setBLEMTU readBLECharacteristicValue \
  writeBLECharacteristicValue notifyBLECharacteristicValueChange showBLEPermissionGuide \
  startBeaconDiscovery stopBeaconDiscovery getBeacons \
  onBluetoothAdapterStateChange onBluetoothDeviceFound onBLEConnectionStateChanged \
  onBLECharacteristicValueChange onBeaconUpdate onBeaconServiceChange \
  offBluetoothAdapterStateChange offBluetoothDeviceFound offBLEConnectionStateChanged \
  offBLECharacteristicValueChange offBeaconUpdate offBeaconServiceChange; do
  grep -q "export function ${api}(" "$DTS" && echo "OK  $api" || echo "MISS $api"
done | grep MISS || echo "全部 API 均存在于 @mini-types/my"
```

预期：输出 `全部 API 均存在于 @mini-types/my`。若有 `MISS`，停止并核对清单后再继续。

- [ ] **Step 2: 创建 src/bluetooth-apis.ts**

```ts
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
```

- [ ] **Step 3: 修改 src/index.ts —— 类型与构造器**

文件顶部 import 之后新增：

```ts
import { BLUETOOTH_ONE_SHOT_APIS, BLUETOOTH_EVENT_APIS } from './bluetooth-apis'
```

`ProxyMessage` 接口增加字段（`error?: ...` 之后）：

```ts
  role?: string
  proxyMode?: string
  data?: unknown
```

**注意：`declare const my` 保持原样，不加索引签名**（索引签名会把 `my.call` 等既有签名退化成 `any`，丢掉类型保护）。所有对蓝牙 API 的动态读写一律通过 `(my as any)` 局部断言完成。

`MyCallProxy` 类之前新增选项接口与结果路由辅助函数：

```ts
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
```

`MyCallProxy` 类字段区新增（保留原有字段声明，加在 `private _rejectConnect ...` 之后）：

```ts
  private options: MyCallProxyOptions
  private originalNamedApis = new Map<string, any>() // api → 原始具名函数（还原用）
  private eventListeners = new Map<string, Set<(data: any) => void>>() // api → 本地监听回调
  private subscribedApis = new Set<string>() // 已向真机发过订阅的 api（断线清空，重连补订阅）
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private socketListenersBound = false // my.onSocket* 只绑定一次（可累积注册，重复绑定会导致回调倍数触发）
  private offlineRetryCounts = new Map<string, number>() // api → DEVICE_OFFLINE 连续重试次数（防真机长期不注册时无限循环）
```

构造器替换为：

```ts
  constructor(serverUrl: string, options: MyCallProxyOptions = {}) {
    this.serverUrl = serverUrl
    this.options = options
  }
```

- [ ] **Step 4: 修改 src/index.ts —— init() 分支**

`init()` 整体替换为：

```ts
  // 初始化代理
  init(): boolean {
    if (typeof my === 'undefined' || typeof my.call !== 'function') {
      console.error('my.call 不存在，无法初始化代理')
      return false
    }

    // 保存原始 my.call
    this.originalMyCall = my.call

    if (this.options.bluetooth) {
      // 蓝牙模式：重写 my 上的蓝牙具名 API，不劫持 my.call
      this.setupBluetoothProxy()
      this.connect()
      console.log('[MyCallProxy] ✅ 蓝牙 API 代理已初始化（仅代理蓝牙 API）')
      return true
    }

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
```

- [ ] **Step 5: 修改 src/index.ts —— connect() 重构，事件监听只绑定一次**

**背景**：`ensureSubscribed` 新增了 `this.connect()` 调用点（原代码里 `connect()` 只在 `init()` 中调用过一次），而 `my.onSocket*` 是**可累积注册**（不是覆盖）。若不改，断线重连一次就会多挂一套 `onSocketMessage`，单条事件会触发 N 次业务回调。

`connect()` 整体替换为（四个 `my.onSocket*` 注册搬进 `bindSocketListeners()`）：

```ts
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

      // 事件监听只绑定一次：my.onSocket* 是可累积注册，重复绑定会让重连后回调倍数触发
      this.bindSocketListeners()
    } catch (error) {
      console.error('[MyCallProxy] 连接失败:', error)
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
      console.log('[MyCallProxy] 🔗 已连接到代理服务器')
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
```

（`onSocketError` 回调里不调 `stopHeartbeat()`：只有真正断开（`onSocketClose`）才需要停心跳，错误回调后连接可能仍存活。）

- [ ] **Step 6: 修改 src/index.ts —— handleMessage() 增加 event 分支与订阅失败处理**

6a. `handleMessage` 中 `} else if (type === 'error') {` 之前插入：

```ts
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
```

6b. `type === 'error'` 分支整体替换为（新增无 pending 时的事件订阅拒绝处理）：

```ts
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
```

（`DEVICE_OFFLINE` 重试依赖 Task 1 Step 5f 给 `sendError` 增加的 `api` 字段——没有它，这条分支永远匹配不到，订阅会静默失效。）

- [ ] **Step 7: 修改 src/index.ts —— 新增蓝牙重写层方法**

在 `fallbackToOriginal` 方法之后新增以下方法（同一 class 内；所有动态读写走 `(my as any)`）：

```ts
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
    ;(my as any)[api] = (cb: (data: any) => void) => {
      if (typeof cb !== 'function') {
        return
      }
      let listeners = self.eventListeners.get(api)
      if (!listeners) {
        listeners = new Set()
        self.eventListeners.set(api, listeners)
      }
      listeners.add(cb)
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
        self.waitForConnection()
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
      fail: (err) => console.error('[MyCallProxy] 模拟器注册发送失败:', err),
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
```

- [ ] **Step 8: 修改 src/index.ts —— destroy() 清理蓝牙状态**

`destroy()` 整体替换为：

```ts
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
    console.log('[MyCallProxy] 🔌 my.call 代理已销毁')
  }
```

- [ ] **Step 9: 类型检查与构建**

```bash
cd /Volumes/KIOXIA/workspace/xiaolian/100_miniapp/jsapi_proxy && pnpm type-check && pnpm build
```

预期：均无错误退出（`dist/index.js`、`dist/index.d.ts`、`dist/server.js` 产出）。

- [ ] **Step 10: 端到端冒烟验证**

创建 `/tmp/smoke-bluetooth.mts`：

```ts
// 蓝牙代理端到端冒烟：进程内起服务端 + 模拟真机端 + mock 模拟器容器（临时，不提交）
import assert from 'node:assert'
import { createRequire } from 'node:module'

const PROJECT = '/Volumes/KIOXIA/workspace/xiaolian/100_miniapp/jsapi_proxy'
const require = createRequire(PROJECT + '/package.json')
const WebSocket = require('ws')
const { default: MyCallProxy } = await import(PROJECT + '/src/index.ts')
const { ProxyServer } = await import(PROJECT + '/src/server/server.ts')

const PORT = 7599
const DEVICE_ID = 'device_smoke_test'

// ---- 进程内启动服务端 ----
const server = new ProxyServer({ port: PORT })
server.start()
await new Promise((r) => setTimeout(r, 300))

// ---- 模拟真机小程序端 ----
const stats = { oneShot: [] as string[], eventSubscribes: 0, offCalls: 0 }
const phone = new WebSocket(`ws://127.0.0.1:${PORT}/ws?type=miniapp`)
await new Promise((r: any) => phone.on('open', r))
phone.on('message', (raw: Buffer) => {
  const msg = JSON.parse(raw.toString())
  if (msg.type !== 'client_call') return
  if (msg.proxyMode === 'event') {
    stats.eventSubscribes++
    // onBeaconUpdate 模拟真机不支持：回订阅错误
    if (msg.api === 'onBeaconUpdate') {
      phone.send(JSON.stringify({
        type: 'error', msgId: msg.msgId, api: msg.api, deviceId: DEVICE_ID,
        error: { code: 'API_NOT_FOUND', message: 'mock unsupported' },
      }))
      return
    }
    // 模拟真机注册监听后触发两次事件（deviceId 回显订阅来源，支持多设备场景）
    phone.send(JSON.stringify({
      type: 'event', msgId: msg.msgId, api: msg.api, deviceId: msg.deviceId,
      data: { devices: [{ name: 'device-1' }] },
    }))
    setTimeout(() => {
      phone.send(JSON.stringify({
        type: 'event', msgId: msg.msgId, api: msg.api, deviceId: msg.deviceId,
        data: { devices: [{ name: 'device-2' }] },
      }))
    }, 50)
    return
  }
  if (/^off/.test(msg.api)) {
    stats.offCalls++
    phone.send(JSON.stringify({ type: 'response', msgId: msg.msgId, result: { success: true } }))
    return
  }
  stats.oneShot.push(msg.api)
  // writeBLECharacteristicValue 模拟失败分支；
  // getBluetoothAdapterState 模拟旧版 error:'0' 成功哨兵；
  // connectBLEDevice 模拟 BLE success 回调自带的 error 空串（最易被误判为失败）
  let result: any = { success: true, mocked: true }
  if (msg.api === 'writeBLECharacteristicValue') {
    result = { success: false, error: 10000, errorMessage: 'mock write fail' }
  } else if (msg.api === 'getBluetoothAdapterState') {
    result = { error: '0', errorMessage: 'ok', available: true }
  } else if (msg.api === 'connectBLEDevice') {
    result = { error: '', errorMessage: '' }
  }
  phone.send(JSON.stringify({ type: 'response', msgId: msg.msgId, result }))
})
phone.send(JSON.stringify({ type: 'register', msgId: 'r_phone', deviceId: DEVICE_ID, deviceInfo: { name: 'fake-phone' } }))

// ---- mock 模拟器容器全局 my ----
// 忠实模拟 my.onSocket* 的「容器级累积注册」语义：回调注册在容器上、与具体 socket 实例无关，
// 新 socket 建立时挂载全部已注册回调。这样才能真实复现「重复绑定 → 回调倍数触发」这个 bug。
let simWs: any = null
let localMyCallCount = 0
const socketHandlers: { open: any[]; message: any[]; error: any[]; close: any[] } = {
  open: [],
  message: [],
  error: [],
  close: [],
}
const my: any = {
  call: (api: string, params: any, cb: any) => {
    localMyCallCount++
    cb && cb({ success: true, from: 'simulator-local' })
  },
  connectSocket: ({ url, success, fail }: any) => {
    try {
      simWs = new WebSocket(url)
      simWs.on('open', () => socketHandlers.open.forEach((cb) => cb()))
      simWs.on('message', (d: Buffer) => socketHandlers.message.forEach((cb) => cb({ data: d.toString() })))
      simWs.on('error', (e: any) => socketHandlers.error.forEach((cb) => cb(e)))
      simWs.on('close', () => socketHandlers.close.forEach((cb) => cb()))
      success && success()
    } catch (e) {
      fail && fail(e)
    }
  },
  onSocketOpen: (cb: any) => {
    socketHandlers.open.push(cb)
  },
  onSocketMessage: (cb: any) => {
    socketHandlers.message.push(cb)
  },
  onSocketError: (cb: any) => {
    socketHandlers.error.push(cb)
  },
  onSocketClose: (cb: any) => {
    socketHandlers.close.push(cb)
  },
  sendSocketMessage: ({ data, success, fail }: any) => {
    if (simWs && simWs.readyState === WebSocket.OPEN) {
      simWs.send(data)
      success && success()
    } else {
      fail && fail(new Error('socket not open'))
    }
  },
  closeSocket: () => simWs && simWs.close(),
}
;(globalThis as any).my = my

// ---- 初始化代理（蓝牙开关） ----
const proxy = new MyCallProxy(`ws://127.0.0.1:${PORT}?deviceId=${DEVICE_ID}`, { bluetooth: true })
proxy.init()

for (let i = 0; i < 50 && !proxy.getStatus().isConnected; i++) {
  await new Promise((r) => setTimeout(r, 100))
}
assert.ok(proxy.getStatus().isConnected, '代理应连接成功')

// 1. 一次性调用 success 路由
await new Promise<void>((resolve, reject) => {
  my.openBluetoothAdapter({
    success: (r: any) => {
      assert.strictEqual(r.success, true)
      assert.strictEqual(r.mocked, true)
      resolve()
    },
    fail: () => reject(new Error('不应触发 fail')),
  })
})
console.log('✅ 1. openBluetoothAdapter success 路由')

// 2. 一次性调用 fail 路由
await new Promise<void>((resolve, reject) => {
  my.writeBLECharacteristicValue({
    value: '00ff',
    success: () => reject(new Error('不应触发 success')),
    fail: (r: any) => {
      assert.strictEqual(r.error, 10000)
      resolve()
    },
  })
})
console.log('✅ 2. writeBLECharacteristicValue fail 路由')

// 3. 事件多播：cb 触发两次
await new Promise<void>((resolve, reject) => {
  let count = 0
  my.onBluetoothDeviceFound((data: any) => {
    count++
    if (count === 1) assert.strictEqual(data.devices[0].name, 'device-1')
    if (count === 2) {
      assert.strictEqual(data.devices[0].name, 'device-2')
      resolve()
    }
  })
  setTimeout(() => reject(new Error('事件未触发两次')), 2000)
})
console.log('✅ 3. onBluetoothDeviceFound 事件多播（2 次）')

// 4. off 解绑转发
my.offBluetoothDeviceFound()
await new Promise((r) => setTimeout(r, 200))
assert.ok(stats.offCalls >= 1, 'off 应转发到真机')
console.log('✅ 4. offBluetoothDeviceFound 转发')

// 5. my.call 未被劫持，保持本地执行
await new Promise<void>((resolve) => {
  my.call('xlGetAppInfo', {}, (r: any) => {
    assert.strictEqual(r.from, 'simulator-local')
    resolve()
  })
})
assert.strictEqual(localMyCallCount, 1, 'my.call 不应被代理')
console.log('✅ 5. my.call 保持本地执行（未被劫持）')

// 6. BLE success 回调自带 error 字段（空串哨兵）应路由到 success
//    最易误判的形态：connectBLEDevice 成功时返回 { error: '', errorMessage: '' }
await new Promise<void>((resolve, reject) => {
  my.connectBLEDevice({
    deviceId: 'AA:BB:CC:DD:EE:FF',
    success: (r: any) => {
      assert.strictEqual(r.error, '')
      resolve()
    },
    fail: () => reject(new Error("error:'' 应回路由到 success")),
    complete: () => resolve(),
  })
})
console.log("✅ 6. error:'' 空串哨兵路由到 success")

// 7. 旧版 error:'0' 成功哨兵路由到 success，complete 必调
await new Promise<void>((resolve, reject) => {
  my.getBluetoothAdapterState({
    success: (r: any) => {
      assert.strictEqual(r.error, '0')
      assert.strictEqual(r.available, true)
      resolve()
    },
    fail: () => reject(new Error("error:'0' 应回路由到 success")),
    complete: () => resolve(),
  })
})
console.log("✅ 7. error:'0' 成功哨兵路由到 success 且 complete 必调")

// 8. 真机侧调用统计正确（必须放在所有一次性调用之后断言，否则数组还未收齐）
assert.deepStrictEqual(
  stats.oneShot.sort(),
  ['connectBLEDevice', 'getBluetoothAdapterState', 'openBluetoothAdapter', 'writeBLECharacteristicValue'],
)
assert.strictEqual(stats.eventSubscribes, 1, '重复 on 注册只发一次订阅')
console.log('✅ 8. 真机侧调用统计正确')

// 9. 订阅被真机拒绝：不污染业务回调
let beaconFired = false
my.onBeaconUpdate(() => {
  beaconFired = true
})
await new Promise((r) => setTimeout(r, 300))
assert.strictEqual(beaconFired, false, '被拒绝的订阅不应分发错误对象给业务回调')
console.log('✅ 9. 订阅被拒绝时不污染业务回调')

// 10. 重连：socket 事件监听不重复绑定 + 订阅自动恢复
//     （若 connect() 每次重新注册 my.onSocket*，单条消息会触发多次回调）
simWs.close()
await new Promise((r) => setTimeout(r, 300))
assert.strictEqual(proxy.getStatus().isConnected, false, '关闭后应处于未连接状态')

let svcEventCount = 0
my.onBeaconServiceChange(() => {
  svcEventCount++
})
// 未连接时 on* 会触发重连，连接成功后 resubscribeAllEvents 补订阅
for (let i = 0; i < 50 && !proxy.getStatus().isConnected; i++) {
  await new Promise((r) => setTimeout(r, 100))
}
assert.ok(proxy.getStatus().isConnected, '重连应成功')
assert.strictEqual(socketHandlers.message.length, 1, 'onSocketMessage 只应绑定一次（可累积注册，重复绑定会让回调倍数触发）')

await new Promise((r) => setTimeout(r, 500))
// mock 真机对每次订阅推 2 条事件；若监听被重复绑定，这里会变成 4
assert.strictEqual(svcEventCount, 2, '重连补订阅生效，且单条事件只触发一次回调')
console.log('✅ 10. 重连后事件监听未重复绑定且订阅自动恢复')

// 11. 模拟器先连、真机后注册：DEVICE_OFFLINE 拒绝后 2s 自动补订阅
//     （proxy2.init 会再次重写具名 API，此后 on* 走 proxy2，属于真实容器语义）
const LATE_ID = 'device_late_register'
const proxy2 = new MyCallProxy(`ws://127.0.0.1:${PORT}?deviceId=${LATE_ID}`, { bluetooth: true })
proxy2.init()
for (let i = 0; i < 50 && !proxy2.getStatus().isConnected; i++) {
  await new Promise((r) => setTimeout(r, 100))
}
assert.ok(proxy2.getStatus().isConnected, 'proxy2 应连接成功')

let lateEventFired = false
my.onBluetoothDeviceFound(() => {
  lateEventFired = true
})
// 订阅此刻已被 DEVICE_OFFLINE 拒绝；真机 1s 后才注册 LATE_ID
setTimeout(() => {
  phone.send(JSON.stringify({ type: 'register', msgId: 'r_late', deviceId: LATE_ID, deviceInfo: {} }))
}, 1000)
for (let i = 0; i < 50 && !lateEventFired; i++) {
  await new Promise((r) => setTimeout(r, 200))
}
assert.ok(lateEventFired, 'DEVICE_OFFLINE 后应自动补订阅并收到事件')
console.log('✅ 11. 模拟器先连、真机后注册：自动补订阅生效')

console.log('\n🎉 冒烟测试全部通过')
server.stop()
process.exit(0)
```

运行：

```bash
cd /Volumes/KIOXIA/workspace/xiaolian/100_miniapp/jsapi_proxy && npx tsx /tmp/smoke-bluetooth.mts
```

预期：输出 `✅ 1.` 至 `✅ 11.` 与 `🎉 冒烟测试全部通过`，退出码 0。

- [ ] **Step 11: 提交**

```bash
cd /Volumes/KIOXIA/workspace/xiaolian/100_miniapp/jsapi_proxy
git add src/bluetooth-apis.ts src/index.ts
git commit -m "feat(client): 支持蓝牙 API 代理开关与事件多播"
```

（提交说明中注明：src/index.ts 超过 300 行软上限，系已有单文件客户端扩展，拆分会暴露连接内部状态。）

---

### Task 3: miniapp 支持事件订阅与解绑分支

**Files:**
- Modify: `miniapp/pages/index/index.js`

**Interfaces:**
- Consumes: 模拟器发来的 `{type:'client_call', api, params, proxyMode:'event'}`（订阅）与 `{type:'client_call', api:'off*'}`（解绑）；协议与 Task 2 Produces 一致
- Produces: `{type:'event', msgId, api, deviceId, timestamp, data}` 多播消息；`off*` 与一次性调用的 `{type:'response', msgId, result}`；订阅被拒时 `{type:'error', msgId, api, deviceId, timestamp, error}`

- [ ] **Step 1: 增加 off 白名单常量**

文件顶部 `import` 语句之后、`Page({` 之前新增：

```js
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
```

- [ ] **Step 2: 修改 handleApiCall 并新增三个方法**

将 `handleApiCall` 方法整体替换为：

```js
  handleApiCall(message) {
    const { msgId, api, params, proxyMode } = message

    console.log('执行 API 调用:', api, params)

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
      this.sendResponse(msgId, { success: true })
      return
    }

    my.call(api, params || {}, (result) => {
      console.log('API 返回结果:', result)
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
      // 用 type:'error' 回报（携带 api），不伪装成事件污染业务回调
      this.sendSubscriptionError(msgId, api, 'unsupported api: ' + api)
      return
    }
    native((data) => {
      console.log('事件触发:', api, data)
      this.sendEvent(msgId, api, data)
    })
    console.log('已注册事件监听:', api)
  },

  sendEvent(msgId, api, data) {
    my.sendSocketMessage({
      data: JSON.stringify({
        type: 'event',
        msgId: msgId,
        api: api,
        deviceId: this.data.deviceId,
        timestamp: Date.now(),
        data: data,
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
        result: result,
      }),
      fail: (err) => {
        console.error('响应发送失败', err)
      },
    })
  },
```

注意：原 `handleApiCall` 内联的 `my.sendSocketMessage({...type:'response'...})` 逻辑由 `sendResponse` 承接，Page 对象中方法之间用 `,` 分隔（保持文件原有风格）。

- [ ] **Step 3: 语法解析验证**

```bash
cd /Volumes/KIOXIA/workspace/xiaolian/100_miniapp/jsapi_proxy && pnpm exec esbuild miniapp/pages/index/index.js > /dev/null && echo "语法 OK"
```

预期：输出 `语法 OK`。

- [ ] **Step 4: 协议一致性走查（人工核对项，逐条确认）**

- 订阅消息 `proxyMode:'event'` 由模拟器 `sendEventSubscribe` 发出 → miniapp `handleEventSubscribe` 消费 ✓
- 事件消息字段 `type/msgId/api/deviceId/timestamp/data` 与客户端 `handleMessage` 的 `event` 分支取用字段一致 ✓
- 订阅错误 `type:'error'` 带 `api` → 服务端 `handlePhoneError` 按 deviceId 转发 → 客户端 error 分支无 pending 时按 `message.api` 解除订阅标记 ✓
- off 转发由 `proxyCall` 发出（一次性），miniapp 按白名单用具名 API 解绑并回 `response`，客户端 `pendingCalls` 正常清理 ✓
- off 白名单与 `src/bluetooth-apis.ts` 的 6 个 `on*` 前缀替换结果逐一对应 ✓
- 真机一次性调用走 `my.call(api, params, cb)` 泛化通道——**此项以前提成立为条件**：Task 0 spike 结论必须为「`my.call` 能调起蓝牙 API」。若结论为「不能」，本步改为用具名 API + `__ok` 归一化，并同步改 Task 2 Step 3 的 `isSuccessResult` ✓

- [ ] **Step 5: 提交**

```bash
cd /Volumes/KIOXIA/workspace/xiaolian/100_miniapp/jsapi_proxy
git add miniapp/pages/index/index.js
git commit -m "feat(miniapp): 支持蓝牙事件订阅与解绑分支"
```

（说明：miniapp 运行行为无法在本机自动化验证，需真机联测；如实告知用户。）

---

### Task 4: 文档更新与收尾

**Files:**
- Modify: `README.md`
- Modify: `miniapp/USAGE.md`
- Modify: `package.json`（版本号 1.1.0 → 1.2.0；依赖变更已在 Task 1 单独提交，本次仅含版本号）

**Interfaces:**
- Consumes: Task 2 的 `MyCallProxyOptions { bluetooth?: boolean }` 对外用法
- Produces: 无（文档）

- [ ] **Step 1: README.md 增加蓝牙代理模式章节**

在「快速开始」的「### 3. 模拟器客户端接入」小节代码示例之后、「## 开发」之前插入：

```markdown
### 蓝牙代理模式（可选）

模拟器不支持蓝牙调试时，可开启蓝牙开关：只把蓝牙相关 API 转发到真机执行，其余 `my.*` 调用（含业务自定义 JSAPI）保持模拟器本地执行：

\`\`\`javascript
import MyCallProxy from 'mpaas-jsapi-proxy';

const proxy = new MyCallProxy('ws://192.168.0.12:3000?deviceId=device_xxx', { bluetooth: true });
proxy.init();

// 一次性 API 走真机，success/fail 按真机结果自动路由
my.openBluetoothAdapter({
  success: (res) => console.log('适配器已打开', res),
  fail: (err) => console.error('打开失败', err),
});

// 监听类 API：真机触发，经服务器多播回模拟器
my.onBluetoothDeviceFound((res) => {
  console.log('发现设备', res.devices);
});
\`\`\`

开启后：

- 一次性 API（\`openBluetoothAdapter\`、\`writeBLECharacteristicValue\`、\`getBluetoothDevices\` 等）原路返回
- 监听类 API（\`onBluetoothDeviceFound\`、\`onBLECharacteristicValueChange\` 等）由真机触发多播，\`offXxx\` 全量解绑并同步真机
- \`my.call\` 与其他 \`my.*\` API 完全不受影响；不传 \`bluetooth\` 时保持原有全量代理行为
- 注意：蓝牙模式下若通过 \`my.call('openBluetoothAdapter', ...)\` 泛化方式调用蓝牙 API，**不会**被代理（该模式不劫持 \`my.call\`），请使用具名 API 写法
```

「功能特性」列表中追加一行：

```markdown
- 蓝牙代理开关：`{ bluetooth: true }` 仅代理蓝牙 API（含事件多播）到真机，其余保持模拟器本地执行
```

- [ ] **Step 2: miniapp/USAGE.md 增加蓝牙说明**

在「### 4. 测试代理」小节末尾追加：

```markdown
### 5. 蓝牙代理模式

模拟器端初始化时传入 `{ bluetooth: true }`，即可把蓝牙相关 API 转发到真机执行（监听类 API 由真机触发、多播回模拟器）：

\`\`\`javascript
const proxy = new MyCallProxy('ws://192.168.0.12:3000?deviceId=device_xxx', { bluetooth: true });
proxy.init();

my.openBluetoothAdapter({
  success: (res) => console.log(res),
  fail: (err) => console.error(err),
});
\`\`\`

真机小程序无需额外配置，自动支持事件订阅（\`onBluetoothDeviceFound\` 等）、解绑（\`offXxx\`）与订阅错误回报的转发。
```

- [ ] **Step 3: 版本号**

`package.json` 中 `"version": "1.1.0"` 改为 `"version": "1.2.0"`。

- [ ] **Step 4: 全量验证**

```bash
cd /Volumes/KIOXIA/workspace/xiaolian/100_miniapp/jsapi_proxy && pnpm type-check && pnpm build && npx tsx /tmp/smoke-bluetooth.mts
```

预期：全部通过。

- [ ] **Step 5: 提交**

```bash
cd /Volumes/KIOXIA/workspace/xiaolian/100_miniapp/jsapi_proxy
git add README.md miniapp/USAGE.md package.json
git commit -m "docs: 补充蓝牙代理模式使用说明"
```

---

## 真机联测清单（无法自动化，交付时告知用户）

0. **先做 Task 0 spike**：确认真机上 `my.call` 能调起蓝牙 API，并记录 success 回调里 `error`/`errorCode` 的真实类型与取值
   - 2026-09-10 真机日志部分结论：**监听类已证实**——泛化 `my.call` 与具名 API 双注册均能收到 `onBluetoothDeviceFound` 事件、成对触发且数据一致（devices 含 RSSI/deviceId/name/manufacturerData 等，全部为 string/hex 字段，JSON 安全）；另发现容器向回调对象注入 `NBPageUrl` 字段，miniapp 端 `stripContainerFields` 已剔除
   - **待补**：一次性调用的返回形态（`openBluetoothAdapter`/`getBluetoothAdapterState`/`connectBLEDevice`/`writeBLECharacteristicValue` 的 success/fail 中 `error`/`errorCode` 实际类型与取值）与「真机不支持 API」的表现，需在测试台点 Spike 区按钮和 BLE 流程后回填
1. 真机小程序连接服务器，模拟器以 `{ bluetooth: true }` 初始化
2. `my.openBluetoothAdapter({success, fail})` → 真机弹蓝牙授权，授权后 success 回调收到 `{ isSupportBLE: true }`
   （注意：`openBluetoothAdapter` 的 success 参数是 `{ isSupportBLE: boolean }`，**没有** `success` 字段，不要写成断言 `success:true`）
3. `my.startBluetoothDevicesDiscovery({})` + `my.onBluetoothDeviceFound(cb)` → cb 随发现设备多次触发
4. `my.connectBLEDevice({deviceId})` → `my.getBLEDeviceServices({deviceId})` → `my.notifyBLECharacteristicValueChange({...})` → `my.onBLECharacteristicValueChange(cb)` → 对端写特征值，cb 收到 16 进制字符串
   （注意：`connectBLEDevice` 的 success 回调自带 `{ error: string, errorMessage: string }`，成功时 `error` 可能是 `''` 或 `'0'`；若这里被路由到 `fail`，依次检查 Task 2 Step 3 的 `isSuccessResult` 与 Task 0 的 spike 结论）
5. `my.offBluetoothDeviceFound()` 后事件停止；`my.call('业务自定义JSAPI')` 不经过真机
6. 真机杀掉小程序重开、模拟器刷新重连后，事件订阅自动恢复（重连补订阅链路），且单条事件只触发一次回调（验证监听未被重复绑定）
7. 时序补充：**模拟器先连、真机后注册**时，订阅会先被 `DEVICE_OFFLINE` 拒绝，客户端 2s 后自动补订阅（上限 30 次，超限需重新订阅或重连），最终应看到事件正常到达
