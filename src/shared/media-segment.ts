import crypto from 'node:crypto';
import { EncryptInfo } from './encrypt-info';
import { ENCRYPT_METHODS } from './encrypt-method';

export class MediaSegment {
  index: number = NaN;
  duration: number = NaN;
  title?: string;
  dateTime?: Date;

  startRange?: number;
  get stopRange(): number | undefined {
    return this.startRange !== undefined && this.expectLength !== undefined
      ? this.startRange + this.expectLength - 1
      : undefined;
  }
  expectLength?: number;

  encryptInfo = new EncryptInfo();

  get isEncrypted() {
    return this.encryptInfo.method !== ENCRYPT_METHODS.NONE;
  }

  url = '';
  nameFromVar?: string;

  equals(segment: unknown) {
    if (segment instanceof MediaSegment) {
      return (
        this.index == segment.index &&
        Math.abs(this.duration - segment.duration) < 0.001 &&
        this.title == segment.title &&
        this.startRange == segment.startRange &&
        this.stopRange == segment.stopRange &&
        this.expectLength == segment.expectLength &&
        this.url == segment.url
      );
    } else {
      return false;
    }
  }

  getHashCode() {
    const payload = [
      this.index,
      this.duration,
      this.title,
      this.startRange,
      this.stopRange,
      this.expectLength,
      this.url,
    ].join('-');
    return crypto.createHash('md5').update(payload).digest('hex');
  }
}
