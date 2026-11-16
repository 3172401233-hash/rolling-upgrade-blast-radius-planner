import { randomUUID } from 'node:crypto';
import { DeviceCodeError, DeviceCodeErrorCodes } from './errors.js';
import { KeyedMutex } from './mutex.js';

export const DeviceCodeStatus = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
  EXPIRED: 'expired',
  CONSUMED: 'consumed'
});

const TERMINAL_STATUSES = new Set([
  DeviceCodeStatus.DENIED,
  DeviceCodeStatus.EXPIRED,
  DeviceCodeStatus.CONSUMED
]);

const DEFAULT_OPTIONS = Object.freeze({
  expiresInSeconds: 900,
  intervalSeconds: 5,
  accessTokenTtlSeconds: 3600,
  tokenFactory: () => `tok_${randomUUID()}`
});

export class DeviceCodeService {
  #byDeviceCode = new Map();
  #byUserCode = new Map();
  #mutex = new KeyedMutex();
  #options;

  constructor(options = {}) {
    this.#options = { ...DEFAULT_OPTIONS, ...options };
  }

  createDeviceAuthorization({
    clientId,
    deviceCode,
    userCode,
    deviceContext,
    now
  }) {
    assertNonEmptyString(clientId, 'clientId');
    assertNonEmptyString(deviceCode, 'deviceCode');
    assertNonEmptyString(userCode, 'userCode');
    if (deviceContext === undefined || deviceContext === null) {
      throw new TypeError('deviceContext is required');
    }
    const issuedAt = requireTime(now);

    if (this.#byUserCode.has(userCode)) {
      throw new DeviceCodeError(
        DeviceCodeErrorCodes.USER_CODE_COLLISION,
        `user_code "${userCode}" is already bound to an active device authorization`
      );
    }

    if (this.#byDeviceCode.has(deviceCode)) {
      throw new Error('device_code is already in use');
    }

    const record = {
      clientId,
      deviceCode,
      userCode,
      deviceContext: deepFreeze(deepClone(deviceContext)),
      status: DeviceCodeStatus.PENDING,
      issuedAt,
      expiresAt: issuedAt + this.#options.expiresInSeconds * 1000,
      lastPollAt: null,
      pollCount: 0,
      decidedAt: null,
      consumedAt: null,
      accessToken: null,
      tokenExpiresAt: null
    };
    this.#byDeviceCode.set(deviceCode, record);
    this.#byUserCode.set(userCode, deviceCode);

    return this.#view(record);
  }

  approve({ userCode, now }) {
    return this.#decide(userCode, DeviceCodeStatus.APPROVED, now);
  }

  deny({ userCode, now }) {
    return this.#decide(userCode, DeviceCodeStatus.DENIED, now);
  }

  async #decide(userCode, targetStatus, now) {
    assertNonEmptyString(userCode, 'userCode');
    const decisionTime = requireTime(now);
    const deviceCode = this.#byUserCode.get(userCode);
    if (!deviceCode) {
      const historical = [...this.#byDeviceCode.values()].find(
        (r) => r.userCode === userCode
      );
      if (historical && historical.status === DeviceCodeStatus.EXPIRED) {
        throw new DeviceCodeError(
          DeviceCodeErrorCodes.EXPIRED_USER_CODE,
          'user_code has expired'
        );
      }
      if (historical && historical.status === DeviceCodeStatus.DENIED) {
        throw new DeviceCodeError(
          DeviceCodeErrorCodes.ALREADY_DECIDED,
          'user_code has already been denied'
        );
      }
      throw new DeviceCodeError(
        DeviceCodeErrorCodes.USER_CODE_NOT_FOUND,
        'unknown user_code'
      );
    }

    return this.#mutex.run(deviceCode, () => {
      const record = this.#requireRecord(deviceCode);
      this.#expireIfNeeded(record, decisionTime);
      if (record.status === DeviceCodeStatus.EXPIRED) {
        throw new DeviceCodeError(
          DeviceCodeErrorCodes.EXPIRED_USER_CODE,
          'user_code has expired'
        );
      }
      if (record.status !== DeviceCodeStatus.PENDING) {
        throw new DeviceCodeError(
          DeviceCodeErrorCodes.ALREADY_DECIDED,
          `user_code is already ${record.status}`
        );
      }
      record.status = targetStatus;
      record.decidedAt = decisionTime;
      if (targetStatus === DeviceCodeStatus.DENIED) {
        this.#byUserCode.delete(userCode);
      }
      return this.#view(record);
    });
  }

  async pollToken({ clientId, deviceCode, deviceContext, now }) {
    assertNonEmptyString(clientId, 'clientId');
    assertNonEmptyString(deviceCode, 'deviceCode');
    if (deviceContext === undefined || deviceContext === null) {
      throw new TypeError('deviceContext is required');
    }
    const pollTime = requireTime(now);

    return this.#mutex.run(deviceCode, () => {
      const record = this.#byDeviceCode.get(deviceCode);
      if (!record) {
        throw new DeviceCodeError(
          DeviceCodeErrorCodes.DEVICE_CODE_NOT_FOUND,
          'unknown device_code'
        );
      }

      if (record.clientId !== clientId) {
        throw new DeviceCodeError(
          DeviceCodeErrorCodes.INVALID_CLIENT,
          'device_code was issued to a different client_id'
        );
      }

      if (!contextEquals(record.deviceContext, deviceContext)) {
        throw new DeviceCodeError(
          DeviceCodeErrorCodes.DEVICE_MISMATCH,
          'token can only be issued to the device that created the device_code'
        );
      }

      if (record.status === DeviceCodeStatus.CONSUMED) {
        throw new DeviceCodeError(
          DeviceCodeErrorCodes.CONSUMED_TOKEN,
          'the authorization for this device_code has already been consumed'
        );
      }

      if (record.status === DeviceCodeStatus.DENIED) {
        throw new DeviceCodeError(
          DeviceCodeErrorCodes.ACCESS_DENIED,
          'the end user denied the authorization request'
        );
      }

      this.#expireIfNeeded(record, pollTime);
      if (record.status === DeviceCodeStatus.EXPIRED) {
        throw new DeviceCodeError(
          DeviceCodeErrorCodes.EXPIRED_TOKEN,
          'device_code has expired'
        );
      }

      if (record.status === DeviceCodeStatus.PENDING) {
        const intervalMs = this.#options.intervalSeconds * 1000;
        if (record.lastPollAt !== null && pollTime < record.lastPollAt + intervalMs) {
          throw new DeviceCodeError(
            DeviceCodeErrorCodes.SLOW_DOWN,
            `polling is allowed at most once every ${this.#options.intervalSeconds}s`
          );
        }
        record.lastPollAt = pollTime;
        record.pollCount += 1;
        throw new DeviceCodeError(
          DeviceCodeErrorCodes.AUTHORIZATION_PENDING,
          'authorization is still pending'
        );
      }

      record.status = DeviceCodeStatus.CONSUMED;
      record.consumedAt = pollTime;
      const accessToken = this.#options.tokenFactory(record);
      record.accessToken = accessToken;
      record.tokenExpiresAt =
        pollTime + this.#options.accessTokenTtlSeconds * 1000;
      this.#byUserCode.delete(record.userCode);

      return this.#tokenView(record);
    });
  }

  getStatus(deviceCode) {
    const record = this.#byDeviceCode.get(deviceCode);
    if (!record) {
      throw new DeviceCodeError(
        DeviceCodeErrorCodes.DEVICE_CODE_NOT_FOUND,
        'unknown device_code'
      );
    }
    return this.#view(record);
  }

  sweepExpired(now) {
    const sweepTime = requireTime(now);
    let removed = 0;
    for (const record of this.#byDeviceCode.values()) {
      if (!TERMINAL_STATUSES.has(record.status)) {
        this.#expireIfNeeded(record, sweepTime);
      }
      if (record.status === DeviceCodeStatus.EXPIRED) {
        this.#byDeviceCode.delete(record.deviceCode);
        this.#byUserCode.delete(record.userCode);
        removed += 1;
      }
    }
    return removed;
  }

  #expireIfNeeded(record, now) {
    if (
      record.status === DeviceCodeStatus.PENDING &&
      now >= record.expiresAt
    ) {
      record.status = DeviceCodeStatus.EXPIRED;
      this.#byUserCode.delete(record.userCode);
    }
  }

  #requireRecord(deviceCode) {
    const record = this.#byDeviceCode.get(deviceCode);
    if (!record) {
      throw new DeviceCodeError(
        DeviceCodeErrorCodes.DEVICE_CODE_NOT_FOUND,
        'unknown device_code'
      );
    }
    return record;
  }

  #view(record) {
    return {
      clientId: record.clientId,
      deviceCode: record.deviceCode,
      userCode: record.userCode,
      deviceContext: deepClone(record.deviceContext),
      status: record.status,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      lastPollAt: record.lastPollAt,
      pollCount: record.pollCount,
      decidedAt: record.decidedAt,
      consumedAt: record.consumedAt
    };
  }

  #tokenView(record) {
    return {
      accessToken: record.accessToken,
      tokenType: 'Bearer',
      expiresIn: this.#options.accessTokenTtlSeconds,
      expiresAt: record.tokenExpiresAt,
      deviceCode: record.deviceCode,
      status: DeviceCodeStatus.CONSUMED,
      consumedAt: record.consumedAt
    };
  }
}

function contextEquals(a, b) {
  if (a === b) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !contextEquals(a[key], b[key])) {
      return false;
    }
  }
  return true;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'object' && value[key] !== null) {
      deepFreeze(value[key]);
    }
  }
  return Object.freeze(value);
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requireTime(now) {
  if (now === undefined) {
    return Date.now();
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError('now must be a finite epoch-millisecond number');
  }
  return now;
}
