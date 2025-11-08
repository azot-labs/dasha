import { AudioCodec, MediaCodec, SubtitleCodec, VideoCodec, VideoDynamicRange } from './codec';
import { Playlist } from './playlist';
import { RoleType } from './role-type';

/**
 * List of all stream types.
 * @group Miscellaneous
 * @public
 */
export const ALL_STREAM_TYPES = ['video', 'audio', 'subtitle'] as const;

/**
 * Union type of all stream types.
 * @group Miscellaneous
 * @public
 */
export type StreamType = (typeof ALL_STREAM_TYPES)[number];

export abstract class StreamInfo {
  abstract get type(): StreamType | undefined;
  codec?: MediaCodec;
  languageCode?: string;
  bitrate?: number;
  name?: string;

  url: string = '';
  originalUrl: string = '';
  playlist?: Playlist;

  default?: boolean;
  skippedDuration?: number;
  role?: RoleType;
  videoRange?: string;
  characteristics?: string;
  publishTime?: Date;
  groupId: string | null = null;
  audioId?: string;
  videoId?: string;
  subtitleId?: string;
  periodId: string | null = null;
  extension: string | null = null;

  /**
   * @deprecated Use `codec`
   */
  codecs: string | null = null;
  /**
   * @deprecated Use `numberOfChannels` in `AudioStreamInfo`
   */
  channels: string | null = null;
  /**
   * @deprecated Use `width` and `height` in `VideoStreamInfo`
   */
  resolution?: string;
  /**
   * @deprecated Use `bitrate`
   */
  bandwidth?: number;

  get segmentsCount(): number {
    return this.playlist?.mediaParts.reduce((sum, part) => sum + part.mediaSegments.length, 0) ?? 0;
  }
}

export class VideoStreamInfo extends StreamInfo {
  codec?: VideoCodec;
  width?: number;
  height?: number;
  frameRate?: number;

  dynamicRange?: VideoDynamicRange;
  dolbyVisionProfile?: 'P5' | 'P7' | 'P8' | string;

  get type() {
    return 'video' as const;
  }

  constructor(info?: Partial<VideoStreamInfo>) {
    super();
    this.codec = info?.codec;
  }

  toShortString() {
    const prefix = `Vid `;
    const bitrate = this.bitrate ? `${this.bitrate / 1000} Kbps` : '';
    const body = [
      this.width ? `${this.width}x${this.height}` : '',
      bitrate,
      this.groupId,
      this.frameRate,
      this.codec ?? this.codecs,
      this.videoRange,
      this.role,
    ]
      .filter(Boolean)
      .join(' | ');
    return `${prefix} | ${body}`.trim();
  }
}

export class AudioStreamInfo extends StreamInfo {
  codec?: AudioCodec;
  numberOfChannels?: number;
  sampleRate?: number;

  atmos?: boolean;
  descriptive?: boolean;
  joc?: number;

  get type() {
    return 'audio' as const;
  }

  constructor(info?: Partial<AudioStreamInfo>) {
    super();
    this.codec = info?.codec;
  }

  toShortString() {
    const prefix = `Aud `;
    const bitrate = this.bitrate ? `${this.bitrate / 1000} Kbps` : '';
    const channels =
      this.numberOfChannels || this.channels ? `${this.numberOfChannels ?? this.channels}CH` : '';
    const body = [
      this.groupId,
      bitrate,
      this.name,
      this.codec ?? this.codecs,
      this.languageCode,
      channels,
      this.role,
    ]
      .filter(Boolean)
      .join(' | ');
    return `${prefix} | ${body}`.trim();
  }
}

export class SubtitleStreamInfo extends StreamInfo {
  codec?: SubtitleCodec;
  cc?: boolean;
  sdh?: boolean;
  forced?: boolean;

  get type() {
    return 'subtitle' as const;
  }

  constructor(info?: Partial<SubtitleStreamInfo>) {
    super();
    this.codec = info?.codec;
  }

  toShortString() {
    const prefix = `Sub `;
    const body = [this.groupId, this.languageCode, this.name, this.codecs, this.role]
      .filter(Boolean)
      .join(' | ');
    return `${prefix} | ${body}`.trim();
  }
}

export type MediaStreamInfo = VideoStreamInfo | AudioStreamInfo | SubtitleStreamInfo;
