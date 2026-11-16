import { DeviceCodeService } from '../lib/index.js';

export const T0 = 1_000_000_000_000;

export function makeService(options = {}) {
  return new DeviceCodeService({
    expiresInSeconds: 60,
    intervalSeconds: 5,
    ...options
  });
}

export function seed(service, overrides = {}) {
  const params = {
    clientId: 'client-a',
    deviceCode: 'dc-1',
    userCode: 'UC-1',
    deviceContext: { deviceId: 'dev-1', fingerprint: 'fp-1' },
    now: T0,
    ...overrides
  };
  const view = service.createDeviceAuthorization(params);
  return { params, view };
}

export function settled(results) {
  return {
    fulfilled: results.filter((r) => r.status === 'fulfilled'),
    rejected: results.filter((r) => r.status === 'rejected')
  };
}

export function rejectionCodes(results) {
  return results
    .filter((r) => r.status === 'rejected')
    .map((r) => r.reason.code);
}
