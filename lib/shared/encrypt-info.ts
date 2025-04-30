import { EncryptMethod } from './encrypt-method';

export class EncryptInfo {
  method: EncryptMethod = EncryptMethod.NONE;
  key?: Buffer;
  iv?: Buffer;

  constructor(method?: string) {
    this.method = this.parseMethod(method);
  }

  parseMethod(method?: string): EncryptMethod {
    if (method !== undefined) {
      return EncryptMethod[method.replace('-', '_')];
    } else {
      return EncryptMethod.UNKNOWN;
    }
  }
}
