import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceCodeErrorCodes, DeviceCodeStatus } from '../lib/index.js';
import { T0, makeService, seed } from './helpers.js';

test('token 只能发放给创建设备码的相同设备上下文', async () => {
  const service = makeService();
  const { params } = seed(service);

  await service.approve({ userCode: params.userCode, now: T0 + 1_000 });

  await assert.rejects(
    () =>
      service.pollToken({
        clientId: params.clientId,
        deviceCode: params.deviceCode,
        deviceContext: { deviceId: 'dev-2', fingerprint: 'fp-1' },
        now: T0 + 2_000
      }),
    { code: DeviceCodeErrorCodes.DEVICE_MISMATCH }
  );
  await assert.rejects(
    () =>
      service.pollToken({
        clientId: params.clientId,
        deviceCode: params.deviceCode,
        deviceContext: { deviceId: 'dev-1', fingerprint: 'tampered' },
        now: T0 + 3_000
      }),
    { code: DeviceCodeErrorCodes.DEVICE_MISMATCH }
  );

  const token = await service.pollToken({
    clientId: params.clientId,
    deviceCode: params.deviceCode,
    deviceContext: { ...params.deviceContext },
    now: T0 + 4_000
  });
  assert.equal(token.status, DeviceCodeStatus.CONSUMED);
});

test('设备替换攻击：另一台设备复用相同短码不能进入成功状态', async () => {
  const service = makeService();
  const original = seed(service, {
    deviceCode: 'dc-1',
    userCode: 'UC-DUP',
    deviceContext: { deviceId: 'original-device' }
  });

  await service.approve({ userCode: original.params.userCode, now: T0 });

  const attacker = {
    deviceId: 'attacker-device',
    ip: '10.0.0.66',
    userAgent: 'evil-agent'
  };
  await assert.rejects(
    () =>
      service.pollToken({
        clientId: original.params.clientId,
        deviceCode: original.params.deviceCode,
        deviceContext: attacker,
        now: T0 + 1_000
      }),
    { code: DeviceCodeErrorCodes.DEVICE_MISMATCH }
  );

  assert.equal(
    service.getStatus(original.params.deviceCode).status,
    DeviceCodeStatus.APPROVED
  );
});

test('短码碰撞：活跃 user_code 被第二个设备复用时拒绝创建', () => {
  const service = makeService();
  seed(service, { deviceCode: 'dc-1', userCode: 'UC-DUP' });

  assert.throws(
    () =>
      service.createDeviceAuthorization({
        clientId: 'client-a',
        deviceCode: 'dc-2',
        userCode: 'UC-DUP',
        deviceContext: { deviceId: 'dev-2' },
        now: T0
      }),
    { code: DeviceCodeErrorCodes.USER_CODE_COLLISION }
  );

  assert.equal(service.getStatus('dc-1').status, DeviceCodeStatus.PENDING);
  assert.throws(() => service.getStatus('dc-2'), {
    code: DeviceCodeErrorCodes.DEVICE_CODE_NOT_FOUND
  });
});

test('消费与拒绝后短码释放并可重新分配', async () => {
  const service = makeService();
  const first = seed(service, {
    deviceCode: 'dc-1',
    userCode: 'UC-REUSE',
    deviceContext: { deviceId: 'dev-1' }
  });
  await service.approve({ userCode: first.params.userCode, now: T0 });
  await service.pollToken({
    clientId: first.params.clientId,
    deviceCode: first.params.deviceCode,
    deviceContext: first.params.deviceContext,
    now: T0 + 1_000
  });

  const second = service.createDeviceAuthorization({
    clientId: 'client-b',
    deviceCode: 'dc-2',
    userCode: 'UC-REUSE',
    deviceContext: { deviceId: 'dev-2' },
    now: T0 + 2_000
  });
  assert.equal(second.status, DeviceCodeStatus.PENDING);
  assert.equal(second.deviceCode, 'dc-2');

  const denied = seed(service, {
    clientId: 'client-c',
    deviceCode: 'dc-3',
    userCode: 'UC-DENIED',
    deviceContext: { deviceId: 'dev-3' }
  });
  await service.deny({ userCode: denied.params.userCode, now: T0 + 3_000 });
  const reissued = service.createDeviceAuthorization({
    clientId: 'client-d',
    deviceCode: 'dc-4',
    userCode: 'UC-DENIED',
    deviceContext: { deviceId: 'dev-4' },
    now: T0 + 4_000
  });
  assert.equal(reissued.userCode, 'UC-DENIED');
  assert.equal(reissued.status, DeviceCodeStatus.PENDING);
});

test('客户端不匹配抛 invalid_client，且不泄露设备绑定状态', async () => {
  const service = makeService();
  const { params } = seed(service);
  await service.approve({ userCode: params.userCode, now: T0 });

  await assert.rejects(
    () =>
      service.pollToken({
        clientId: 'other-client',
        deviceCode: params.deviceCode,
        deviceContext: params.deviceContext,
        now: T0 + 1_000
      }),
    { code: DeviceCodeErrorCodes.INVALID_CLIENT }
  );
  assert.equal(
    service.getStatus(params.deviceCode).status,
    DeviceCodeStatus.APPROVED
  );
});

test('一次性授权：消费后任何重试都得到 consumed_token，token 不重复发放', async () => {
  const service = makeService();
  const { params } = seed(service);
  await service.approve({ userCode: params.userCode, now: T0 });

  const first = await service.pollToken({
    clientId: params.clientId,
    deviceCode: params.deviceCode,
    deviceContext: params.deviceContext,
    now: T0 + 1_000
  });

  await assert.rejects(
    () =>
      service.pollToken({
        clientId: params.clientId,
        deviceCode: params.deviceCode,
        deviceContext: params.deviceContext,
        now: T0 + 2_000
      }),
    { code: DeviceCodeErrorCodes.CONSUMED_TOKEN }
  );

  const view = service.getStatus(params.deviceCode);
  assert.equal(view.status, DeviceCodeStatus.CONSUMED);
  assert.equal(view.consumedAt, T0 + 1_000);
  assert.equal(first.accessToken.length > 0, true);
});

test('拒绝后的 user_code 不可再被决定，但设备码仍返回 access_denied', async () => {
  const service = makeService();
  const { params } = seed(service);

  await service.deny({ userCode: params.userCode, now: T0 });
  await assert.rejects(
    service.approve({ userCode: params.userCode, now: T0 + 1_000 }),
    { code: DeviceCodeErrorCodes.ALREADY_DECIDED }
  );
});

test('设备上下文在创建时被快照，外部后续篡改不影响绑定', async () => {
  const service = makeService();
  const context = { deviceId: 'dev-1', nested: { fp: 'fp-1' } };
  service.createDeviceAuthorization({
    clientId: 'client-a',
    deviceCode: 'dc-1',
    userCode: 'UC-1',
    deviceContext: context,
    now: T0
  });
  context.deviceId = 'dev-2';
  context.nested.fp = 'tampered';

  await service.approve({ userCode: 'UC-1', now: T0 + 1_000 });
  const token = await service.pollToken({
    clientId: 'client-a',
    deviceCode: 'dc-1',
    deviceContext: { deviceId: 'dev-1', nested: { fp: 'fp-1' } },
    now: T0 + 2_000
  });
  assert.equal(token.status, DeviceCodeStatus.CONSUMED);
});
