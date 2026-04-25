export const ENCRYPT_METHODS = {
  NONE: 'none',
  AES_128: 'aes-128',
  AES_128_ECB: 'aes-128-ecb',
  SAMPLE_AES: 'sample-aes',
  SAMPLE_AES_CTR: 'sample-aes-ctr',
  CENC: 'cenc',
  CHACHA20: 'chacha20',
  UNKNOWN: 'unknown',
} as const;

export type EncryptMethod = (typeof ENCRYPT_METHODS)[keyof typeof ENCRYPT_METHODS];
