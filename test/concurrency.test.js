import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceCodeErrorCodes, DeviceCodeStatus } from '../lib/index.js';
import { T0, makeService, rejectionCodes, seed, settled } from './helpers.js';

test('并发 approve/deny：只有一个决定生效，另一个得到 already_decided', async () => {
  const service = makeService();
  const { params } = seed(service);

  const results = settled(
    await Promise.allSettled([
      service.approve({ userCode: params.userCode, now: T0 + 1_000 }),
      service.deny({ userCode: params.userCode, now: T0 + 1_000 })
    ])
  );

  assert.equal(results.fulfilled.length, 1);
  assert.equal(results.rejected.length, 1);
  assert.deepEqual(rejectionCodes(results.rejected), [
    DeviceCodeErrorCodes.ALREADY_DECIDED
  ]);
  assert.ok(
    [DeviceCodeStatus.APPROVED, DeviceCodeStatus.DENIED].includes(
      service.getStatus(params.deviceCode).status
    )
  );
});

test('并发重复 approve：恰好一次成功', async () => {
  const service = makeService();
  const { params } = seed(service);

  const results = settled(
    await Promise.allSettled([
      service.approve({ userCode: params.userCode, now: T0 }),
      service.approve({ userCode: params.userCode, now: T0 }),
      service.approve({ userCode: params.userCode, now: T0 })
    ])
  );

  assert.equal(results.fulfilled.length, 1);
  assert.deepEqual(rejectionCodes(results.rejected), [
    DeviceCodeErrorCodes.ALREADY_DECIDED,
    DeviceCodeErrorCodes.ALREADY_DECIDED
  ]);
});

test('已批准记录的并发轮询：恰好一个 token，其余全部 consumed_token', async () => {
  const service = makeService();
  const { params } = seed(service);
  await service.approve({ userCode: params.userCode, now: T0 });

  const poll = () =>
    service.pollToken({
      clientId: params.clientId,
      deviceCode: params.deviceCode,
      deviceContext: params.deviceContext,
      now: T0 + 1_000
    });

  const results = settled(
    await Promise.allSettled([poll(), poll(), poll(), poll()])
  );

  assert.equal(results.fulfilled.length, 1);
  assert.deepEqual(rejectionCodes(results.rejected), [
    DeviceCodeErrorCodes.CONSUMED_TOKEN,
    DeviceCodeErrorCodes.CONSUMED_TOKEN,
    DeviceCodeErrorCodes.CONSUMED_TOKEN
  ]);
  const tokens = new Set(results.fulfilled.map((r) => r.value.accessToken));
  assert.equal(tokens.size, 1);
  assert.equal(
    service.getStatus(params.deviceCode).status,
    DeviceCodeStatus.CONSUMED
  );
});

test('并发轮询过快：首个 pending，其余 slow_down', async () => {
  const service = makeService();
  const { params } = seed(service);

  const poll = () =>
    service.pollToken({
      clientId: params.clientId,
      deviceCode: params.deviceCode,
      deviceContext: params.deviceContext,
      now: T0
    });

  const results = settled(await Promise.allSettled([poll(), poll(), poll()]));

  assert.equal(results.fulfilled.length, 0);
  assert.deepEqual(rejectionCodes(results.rejected).sort(), [
    DeviceCodeErrorCodes.AUTHORIZATION_PENDING,
    DeviceCodeErrorCodes.SLOW_DOWN,
    DeviceCodeErrorCodes.SLOW_DOWN
  ]);
  assert.equal(service.getStatus(params.deviceCode).pollCount, 1);
});

test('设备替换并发：伪造设备永远拿不到 token，原设备恰好消费一次', async () => {
  const service = makeService();
  const { params } = seed(service);
  await service.approve({ userCode: params.userCode, now: T0 });

  const originalPoll = () =>
    service.pollToken({
      clientId: params.clientId,
      deviceCode: params.deviceCode,
      deviceContext: params.deviceContext,
      now: T0 + 1_000
    });
  const attackerPoll = () =>
    service.pollToken({
      clientId: params.clientId,
      deviceCode: params.deviceCode,
      deviceContext: { deviceId: 'attacker-device' },
      now: T0 + 1_000
    });

  const results = settled(
    await Promise.allSettled([
      attackerPoll(),
      originalPoll(),
      attackerPoll(),
      originalPoll()
    ])
  );

  assert.equal(results.fulfilled.length, 1);
  assert.deepEqual(
    rejectionCodes(results.rejected).sort(),
    [
      DeviceCodeErrorCodes.CONSUMED_TOKEN,
      DeviceCodeErrorCodes.DEVICE_MISMATCH,
      DeviceCodeErrorCodes.DEVICE_MISMATCH
    ].sort()
  );
});

test('过期临界时刻并发决定与轮询，状态只向 expired 收敛', async () => {
  const service = makeService();
  const { params } = seed(service);

  const results = settled(
    await Promise.allSettled([
      service.approve({ userCode: params.userCode, now: T0 + 60_000 }),
      service.pollToken({
        clientId: params.clientId,
        deviceCode: params.deviceCode,
        deviceContext: params.deviceContext,
        now: T0 + 60_000
      })
    ])
  );

  assert.equal(results.fulfilled.length, 0);
  assert.deepEqual(rejectionCodes(results.rejected).sort(), [
    DeviceCodeErrorCodes.EXPIRED_TOKEN,
    DeviceCodeErrorCodes.EXPIRED_USER_CODE
  ].sort());
  assert.equal(
    service.getStatus(params.deviceCode).status,
    DeviceCodeStatus.EXPIRED
  );
});
