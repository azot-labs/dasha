import { ENCRYPT_METHODS, EncryptMethod } from './encrypt-method';

export class EncryptInfo {
  method: EncryptMethod = ENCRYPT_METHODS.NONE;
  key?: Buffer;
  iv?: Buffer;

  constructor(method?: string) {
    this.method = this.parseMethod(method);
  }

  parseMethod(method?: string): EncryptMethod {
    if (method !== undefined) {
      return ENCRYPT_METHODS[method.replace('-', '_') as keyof typeof ENCRYPT_METHODS];
    } else {
      return ENCRYPT_METHODS.UNKNOWN;
    }
  }
}
