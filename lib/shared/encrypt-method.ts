export abstract class EncryptMethod {
  static NONE = 0;
  static AES_128 = 1;
  static AES_128_ECB = 2;
  static SAMPLE_AES = 3;
  static SAMPLE_AES_CTR = 4;
  static CENC = 5;
  static CHACHA20 = 6;
  static UNKNOWN = 7;
}
