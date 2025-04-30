import { MEDIA_TYPES, MediaType } from './media-type';
import { Playlist } from './playlist';
import { RoleType } from './role-type';

export class StreamSpec {
  mediaType?: MediaType;
  groupId: string | null = null;
  language?: string;
  name?: string;
  default?: boolean;

  skippedDuration?: number;

  bandwidth?: number;
  codecs: string | null = null;
  resolution?: string;
  frameRate?: number;
  channels: string | null = null;
  extension: string | null = null;

  // DASH
  role?: RoleType;

  videoRange?: string;
  characteristics?: string;
  publishTime?: Date;

  audioId?: string;
  videoId?: string;
  subtitleId?: string;

  periodId: string | null = null;

  url: string = '';
  originalUrl: string = '';

  playlist?: Playlist;

  get segmentsCount(): number {
    return this.playlist?.mediaParts.reduce((sum, part) => sum + part.mediaSegments.length, 0) ?? 0;
  }

  toShortString() {
    let prefixStr = '';
    let returnStr = '';
    let encStr = '';

    const bandwidth = this.bandwidth ? `${this.bandwidth / 1000} Kbps` : '';
    const channels = this.channels ? `${this.channels}CH` : '';

    if (this.mediaType === MEDIA_TYPES.AUDIO) {
      prefixStr = `Aud ${encStr}`;
      returnStr = [
        this.groupId,
        bandwidth,
        this.name,
        this.codecs,
        this.language,
        channels,
        this.role,
      ]
        .filter(Boolean)
        .join(' | ');
    } else if (this.mediaType === MEDIA_TYPES.SUBTITLES) {
      prefixStr = `Sub ${encStr}`;
      returnStr = [this.groupId, this.language, this.name, this.codecs, this.role]
        .filter(Boolean)
        .join(' | ');
    } else {
      prefixStr = `Vid ${encStr}`;
      returnStr = [
        this.resolution,
        bandwidth,
        this.groupId,
        this.frameRate,
        this.codecs,
        this.videoRange,
        this.role,
      ]
        .filter(Boolean)
        .join(' | ');
    }
    returnStr = `${prefixStr} | ${returnStr}`;
    return returnStr.trim();
  }
}
