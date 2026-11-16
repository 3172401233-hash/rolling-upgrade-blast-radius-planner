import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceCodeErrorCodes, DeviceCodeStatus } from '../lib/index.js';
import { T0, makeService, seed } from './helpers.js';

test('新建授权处于 pending，且记录过期时间与轮询元数据', () => {
  const service = makeService();
  const { view } = seed(service);

  assert.equal(view.status, DeviceCodeStatus.PENDING);
  assert.equal(view.issuedAt, T0);
  assert.equal(view.expiresAt, T0 + 60_000);
  assert.equal(view.pollCount, 0);
  assert.equal(view.lastPollAt, null);
  assert.equal(view.consumedAt, null);
});

test('pending 轮询返回 authorization_pending 并记录轮询时间', async () => {
  const service = makeService();
  const { params } = seed(service);

  await assert.rejects(
    () =>
      service.pollToken({
        clientId: params.clientId,
        deviceCode: params.deviceCode,
        deviceContext: params.deviceContext,
        now: T0 + 1_000
      }),
    { code: DeviceCodeErrorCodes.AUTHORIZATION_PENDING }
  );

  const view = service.getStatus(params.deviceCode);
  assert.equal(view.status, DeviceCodeStatus.PENDING);
  assert.equal(view.pollCount, 1);
  assert.equal(view.lastPollAt, T0 + 1_000);
});

test('轮询过快抛 slow_down，到达 interval 边界后恢复 pending', async () => {
  const service = makeService();
  const { params } = seed(service);
  const poll = (now) =>
    service.pollToken({
      clientId: params.clientId,
      deviceCode: params.deviceCode,
      deviceContext: params.deviceContext,
      now
    });

  await assert.rejects(() => poll(T0), {
    code: DeviceCodeErrorCodes.AUTHORIZATION_PENDING
  });
  await assert.rejects(() => poll(T0 + 4_999), {
    code: DeviceCodeErrorCodes.SLOW_DOWN
  });
  assert.equal(service.getStatus(params.deviceCode).pollCount, 1);

  await assert.rejects(() => poll(T0 + 5_000), {
    code: DeviceCodeErrorCodes.AUTHORIZATION_PENDING
  });
  assert.equal(service.getStatus(params.deviceCode).pollCount, 2);
});

test('approve 后轮询一次性发放 token 并进入 consumed', async () => {
  const service = makeService();
  const { params } = seed(service);

  const decision = await service.approve({ userCode: params.userCode, now: T0 + 10_000 });
  assert.equal(decision.status, DeviceCodeStatus.APPROVED);
  assert.equal(decision.decidedAt, T0 + 10_000);

  const token = await service.pollToken({
    clientId: params.clientId,
    deviceCode: params.deviceCode,
    deviceContext: params.deviceContext,
    now: T0 + 15_000
  });

  assert.equal(token.status, DeviceCodeStatus.CONSUMED);
  assert.equal(token.tokenType, 'Bearer');
  assert.equal(token.expiresIn, 3600);
  assert.equal(token.expiresAt, T0 + 15_000 + 3_600_000);
  assert.match(token.accessToken, /^tok_/);
  assert.equal(service.getStatus(params.deviceCode).status, DeviceCodeStatus.CONSUMED);
});

test('deny 后轮询得到 access_denied，状态保持 denied', async () => {
  const service = makeService();
  const { params } = seed(service);

  const decision = await service.deny({ userCode: params.userCode, now: T0 + 2_000 });
  assert.equal(decision.status, DeviceCodeStatus.DENIED);

  await assert.rejects(
    () =>
      service.pollToken({
        clientId: params.clientId,
        deviceCode: params.deviceCode,
        deviceContext: params.deviceContext,
        now: T0 + 3_000
      }),
    { code: DeviceCodeErrorCodes.ACCESS_DENIED }
  );
  assert.equal(service.getStatus(params.deviceCode).status, DeviceCodeStatus.DENIED);
});

test('时钟边界：expiresAt 前一刻仍 pending，到达 expiresAt 立即 expired', async () => {
  const service = makeService();
  const { params } = seed(service);
  const poll = (now) =>
    service.pollToken({
      clientId: params.clientId,
      deviceCode: params.deviceCode,
      deviceContext: params.deviceContext,
      now
    });

  await assert.rejects(() => poll(T0 + 59_999), {
    code: DeviceCodeErrorCodes.AUTHORIZATION_PENDING
  });
  await assert.rejects(() => poll(T0 + 60_000), {
    code: DeviceCodeErrorCodes.EXPIRED_TOKEN
  });
  assert.equal(
    service.getStatus(params.deviceCode).status,
    DeviceCodeStatus.EXPIRED
  );
});

test('过期前完成 approve，即使轮询晚于 expiresAt 仍可消费', async () => {
  const service = makeService();
  const { params } = seed(service);

  await service.approve({ userCode: params.userCode, now: T0 + 59_999 });
  const token = await service.pollToken({
    clientId: params.clientId,
    deviceCode: params.deviceCode,
    deviceContext: params.deviceContext,
    now: T0 + 70_000
  });

  assert.equal(token.status, DeviceCodeStatus.CONSUMED);
});

test('过期后 approve 或 deny 抛 expired_user_code', async () => {
  const service = makeService();
  const { params } = seed(service);

  await assert.rejects(
    service.approve({ userCode: params.userCode, now: T0 + 60_000 }),
    { code: DeviceCodeErrorCodes.EXPIRED_USER_CODE }
  );
  await assert.rejects(
    service.deny({ userCode: params.userCode, now: T0 + 61_000 }),
    { code: DeviceCodeErrorCodes.EXPIRED_USER_CODE }
  );
});

test('重复决定抛 already_decided，首次决定不可被覆盖', async () => {
  const service = makeService();
  const { params } = seed(service);

  await service.approve({ userCode: params.userCode, now: T0 });
  await assert.rejects(
    service.approve({ userCode: params.userCode, now: T0 + 1_000 }),
    { code: DeviceCodeErrorCodes.ALREADY_DECIDED }
  );
  await assert.rejects(
    service.deny({ userCode: params.userCode, now: T0 + 2_000 }),
    { code: DeviceCodeErrorCodes.ALREADY_DECIDED }
  );
  assert.equal(
    service.getStatus(params.deviceCode).status,
    DeviceCodeStatus.APPROVED
  );
});

test('sweepExpired 清理过期记录并返回数量', async () => {
  const service = makeService();
  const first = seed(service, { deviceCode: 'dc-1', userCode: 'UC-1' });
  seed(service, { deviceCode: 'dc-2', userCode: 'UC-2' });

  await service.approve({ userCode: first.params.userCode, now: T0 + 1_000 });
  const removed = service.sweepExpired(T0 + 61_000);

  assert.equal(removed, 1);
  assert.throws(
    () => service.getStatus('dc-2'),
    { code: DeviceCodeErrorCodes.DEVICE_CODE_NOT_FOUND }
  );
  assert.equal(
    service.getStatus('dc-1').status,
    DeviceCodeStatus.APPROVED
  );
});

test('未知 device_code / user_code 返回对应错误', async () => {
  const service = makeService();

  await assert.rejects(
    service.pollToken({
      clientId: 'client-a',
      deviceCode: 'nope',
      deviceContext: { deviceId: 'x' },
      now: T0
    }),
    { code: DeviceCodeErrorCodes.DEVICE_CODE_NOT_FOUND }
  );
  await assert.rejects(
    service.approve({ userCode: 'nope', now: T0 }),
    { code: DeviceCodeErrorCodes.USER_CODE_NOT_FOUND }
  );
});
