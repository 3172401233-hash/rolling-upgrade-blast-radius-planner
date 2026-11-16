# oauth-device-code-validator

JavaScript OAuth 2.0 设备授权（RFC 8628）状态机库。核心安全约束：**token 只能发放给最初创建 `device_code` 的相同设备上下文**，即使其他设备拿到了有效的 `device_code` / `user_code` 也无法换取 token。

纯 ESM、零依赖，时间全部由调用方通过 `now`（epoch 毫秒）显式传入，便于测试时钟边界。

## 安装与测试

```bash
node --test
# 或
npm test
```

要求 Node.js >= 18（使用内置 `node:test`）。

## 快速开始

```js
import { DeviceCodeService, DeviceCodeErrorCodes } from './lib/index.js';

const service = new DeviceCodeService({
  expiresInSeconds: 900,   // device_code / user_code 有效期
  intervalSeconds: 5      // 最小轮询间隔
});

// 1. 设备发起授权，绑定设备上下文（deviceId、指纹、UA、IP 等）
const record = service.createDeviceAuthorization({
  clientId: 'client-a',
  deviceCode: 'dc_abc',
  userCode: 'ABCD-1234',
  deviceContext: { deviceId: 'dev-1', fingerprint: 'fp-1' },
  now: Date.now()
});

// 2. 用户在登录页输入短码后批准 / 拒绝
await service.approve({ userCode: 'ABCD-1234', now: Date.now() });

// 3. 原始设备轮询换取 token；设备上下文不一致会抛 device_mismatch
try {
  const token = await service.pollToken({
    clientId: 'client-a',
    deviceCode: 'dc_abc',
    deviceContext: { deviceId: 'dev-1', fingerprint: 'fp-1' },
    now: Date.now()
  });
  // { accessToken, tokenType: 'Bearer', expiresIn, expiresAt, status: 'consumed' }
} catch (err) {
  console.log(err.code); // 见错误码表
}
```

## 状态模型

状态枚举：`pending`、`approved`、`denied`、`expired`、`consumed`。

| 当前状态 | 事件 | 目标状态 | 说明 |
| --- | --- | --- | --- |
| （无） | `createDeviceAuthorization` | `pending` | 活跃 `user_code` 重复时抛 `user_code_collision` |
| `pending` | `approve` | `approved` | 记录 `decidedAt` |
| `pending` | `deny` | `denied` | 释放 `user_code`，轮询得到 `access_denied` |
| `pending` | `now >= expiresAt` | `expired` | 惰性过期，释放 `user_code` |
| `pending` | `pollToken` | `pending` | 抛 `authorization_pending`；轮询过快抛 `slow_down` |
| `approved` | 原设备 `pollToken` | `consumed` | 发放一次 token，释放 `user_code` |
| `denied` | `pollToken` | `denied` | 抛 `access_denied`，状态不变 |
| `expired` | `pollToken` / `approve` / `deny` | `expired` | 抛 `expired_token` / `expired_user_code` |
| `consumed` | 任何 `pollToken` | `consumed` | 抛 `consumed_token`，不重复发 token |
| `approved` / `denied` | 再次 `approve` / `deny` | 不变 | 抛 `already_decided` |

### 状态转换图

```text
                 create
                   │
                   ▼
                ┌────────┐  approve   ┌──────────┐ 原设备 pollToken ┌──────────┐
                │ pending │──────────▶│ approved │────────────────▶│ consumed │
                └────────┘            └──────────┘                  └──────────┘
                   │  │                    │ 拒绝再 poll → consumed_token
          deny     │  │ now >= expiresAt
                   ▼  ▼
              ┌───────┐ ┌─────────┐
              │ denied│ │ expired │
              └───────┘ └─────────┘
```

## 轮询校验顺序（`pollToken`）

每次轮询按以下顺序短路，保证不泄露其它维度的信息：

1. `device_code` 不存在 → `device_code_not_found`
2. `client_id` 与签发时不一致 → `invalid_client`
3. 设备上下文与创建时不一致 → `device_mismatch`
4. 已消费 → `consumed_token`
5. 已拒绝 → `access_denied`
6. 到达过期时间 → `expired_token`
7. `pending` 且距上次轮询小于 `intervalSeconds` → `slow_down`（不计入轮询次数）
8. `pending` 正常轮询 → `authorization_pending`，更新 `lastPollAt` / `pollCount`
9. `approved` → 原子转为 `consumed` 并返回 token

## 错误码

| 错误码 | 触发场景 |
| --- | --- |
| `user_code_collision` | 活跃短码被另一次授权复用（短码碰撞） |
| `user_code_not_found` | 决定操作使用了未知短码 |
| `expired_user_code` | 对已过期短码执行批准 / 拒绝 |
| `already_decided` | 对已批准 / 已拒绝的短码重复决定 |
| `device_code_not_found` | 轮询了未知的 `device_code` |
| `invalid_client` | `client_id` 与签发记录不匹配 |
| `device_mismatch` | 轮询设备上下文与创建设备不一致（设备替换攻击） |
| `authorization_pending` | `pending` 状态下的正常轮询响应 |
| `slow_down` | 轮询间隔小于 `intervalSeconds` |
| `access_denied` | 用户已拒绝授权 |
| `expired_token` | `device_code` 已过期 |
| `consumed_token` | 授权已被消费后的重放轮询 |

所有错误都是 `DeviceCodeError` 实例，可用 `isDeviceCodeError(err)` 判断。

## 一次性授权语义

- **设备绑定**：创建时对 `deviceContext` 做深拷贝快照并冻结；后续外部对象被篡改不影响绑定，比对采用结构化深比较。
- **单次发放**：`approved → consumed` 在按键互斥锁内原子完成，并发轮询只有一个调用拿到 token，其余得到 `consumed_token`，且不会生成第二个 token。
- **重放保护**：消费后的任何重试（即使来自原设备）都返回 `consumed_token`，token 不会二次发放。
- **短码释放与复用**：`deny`、`expired`、`consumed` 都会释放 `user_code` 索引，之后同一短码可安全分配给新授权；活跃期间碰撞一律拒绝。
- **并发决定**：并发的 `approve` / `deny` 串行化，先到的决定生效，后到的得到 `already_decided`，状态不可回退。
- **时钟边界**：`now === expiresAt` 即判过期（`>=`）；`approved` 之后不再受过期影响，过期前批准的记录仍可被原设备消费。
- **轮询节流**：首次轮询不节流；`slow_down` 不更新轮询时间戳、不增加计数，到达间隔边界后恢复 `authorization_pending`。

## API

### `new DeviceCodeService(options?)`

- `expiresInSeconds`：默认 `900`
- `intervalSeconds`：默认 `5`
- `accessTokenTtlSeconds`：默认 `3600`
- `tokenFactory(record)`：自定义 token 生成函数，默认返回 `tok_<uuid>`

### 方法

- `createDeviceAuthorization({ clientId, deviceCode, userCode, deviceContext, now })`
- `approve({ userCode, now })` / `deny({ userCode, now })`（异步，经互斥锁串行化）
- `pollToken({ clientId, deviceCode, deviceContext, now })`：异步，成功返回 token 视图，失败抛 `DeviceCodeError`
- `getStatus(deviceCode)`：返回不含 token 的只读状态视图
- `sweepExpired(now)`：清理过期记录，返回删除数量

## 目录结构

```text
lib/
  errors.js         # DeviceCodeError 与错误码枚举
  mutex.js          # 按键异步互斥锁（按 device_code 串行化）
  state-machine.js  # DeviceCodeService 状态机
  index.js          # 出口
test/
  state-machine.test.js  # 生命周期、轮询节流、过期边界、重复决定
  security.test.js       # 设备绑定、短码碰撞、客户端不匹配、重放
  concurrency.test.js    # 并发批准、并发轮询、设备替换、过期竞态
```
