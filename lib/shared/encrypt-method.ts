export const ENCRYPT_METHODS = {
  NONE: 0,
  AES_128: 1,
  AES_128_ECB: 2,
  SAMPLE_AES: 3,
  SAMPLE_AES_CTR: 4,
  CENC: 5,
  CHACHA20: 6,
  UNKNOWN: 7,
};

export type EncryptMethod = (typeof ENCRYPT_METHODS)[keyof typeof ENCRYPT_METHODS];
