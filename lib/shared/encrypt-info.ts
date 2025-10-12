import { ENCRYPT_METHODS, EncryptMethod } from './encrypt-method';

type DrmType = 'widevine' | 'playready' | 'fairplay';

export class EncryptInfo {
  method: EncryptMethod = ENCRYPT_METHODS.NONE;
  key?: Buffer;
  iv?: Buffer;
  drm: { [key in DrmType]?: { keyId?: string; pssh?: string } };

  constructor(method?: string | null) {
    this.method = this.parseMethod(method);
    this.drm = {};
  }

  parseMethod(method?: string | null): EncryptMethod {
    if (method) {
      return ENCRYPT_METHODS[method.replace('-', '_') as keyof typeof ENCRYPT_METHODS];
    } else {
      return ENCRYPT_METHODS.UNKNOWN;
    }
  }
}
