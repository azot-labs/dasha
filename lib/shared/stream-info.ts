import { AudioCodec, MediaCodec, SubtitleCodec, VideoCodec, VideoDynamicRange } from './codec';
import { Playlist } from './playlist';
import { ROLE_TYPE, RoleType } from './role-type';

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

const bitrateToString = (bitrate?: number) => {
  return bitrate ? `${Math.round(bitrate / 1000)} Kbps` : '';
};

const roleToString = (role?: RoleType) => {
  for (const [key, value] of Object.entries(ROLE_TYPE)) {
    if (value === role) return key;
  }
  return '';
};

const durationToString = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins > 0) return `~${mins}m${secs.toString().padStart(2, '0')}s`;
  return `~${secs}s`;
};

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
    const prefix = 'Vid';
    const parts = [prefix];
    if (this.width) parts.push(`${this.width}x${this.height}`);
    if (this.bitrate) parts.push(bitrateToString(this.bitrate));
    if (this.groupId) parts.push(this.groupId);
    if (this.frameRate) parts.push(this.frameRate.toString());
    if (this.codec) parts.push(this.codec);
    if (this.videoRange) parts.push(this.videoRange);
    if (this.segmentsCount) parts.push(`${this.segmentsCount} segments`);
    if (this.role) parts.push(roleToString(this.role));
    if (this.playlist) parts.push(durationToString(this.playlist.totalDuration));
    const text = parts.filter(Boolean).join(' | ');
    return text.trim();
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
    const prefix = 'Aud';
    const parts = [prefix];
    if (this.groupId) parts.push(this.groupId);
    if (this.bitrate) parts.push(bitrateToString(this.bitrate));
    if (this.name) parts.push(this.name);
    if (this.codec) parts.push(this.codec);
    if (this.languageCode) parts.push(this.languageCode);
    if (this.numberOfChannels) parts.push(`${this.numberOfChannels}CH`);
    if (this.role) parts.push(roleToString(this.role));
    const text = parts.filter(Boolean).join(' | ');
    return text.trim();
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
    const prefix = 'Sub';
    const parts = [prefix];
    const text = parts.filter(Boolean).join(' | ');
    if (this.groupId) parts.push(this.groupId);
    if (this.languageCode) parts.push(this.languageCode);
    if (this.name) parts.push(this.name);
    if (this.codec) parts.push(this.codec);
    if (this.role) parts.push(roleToString(this.role));
    return text.trim();
  }
}

export type MediaStreamInfo = VideoStreamInfo | AudioStreamInfo | SubtitleStreamInfo;
