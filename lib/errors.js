export const DeviceCodeErrorCodes = Object.freeze({
  USER_CODE_COLLISION: 'user_code_collision',
  EXPIRED_USER_CODE: 'expired_user_code',
  USER_CODE_NOT_FOUND: 'user_code_not_found',
  DEVICE_CODE_NOT_FOUND: 'device_code_not_found',
  INVALID_CLIENT: 'invalid_client',
  DEVICE_MISMATCH: 'device_mismatch',
  AUTHORIZATION_PENDING: 'authorization_pending',
  SLOW_DOWN: 'slow_down',
  ACCESS_DENIED: 'access_denied',
  EXPIRED_TOKEN: 'expired_token',
  CONSUMED_TOKEN: 'consumed_token',
  ALREADY_DECIDED: 'already_decided'
});

export class DeviceCodeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeviceCodeError';
    this.code = code;
  }
}

export function isDeviceCodeError(value) {
  return value instanceof DeviceCodeError;
}
