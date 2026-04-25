import type { MediaCodec, VideoDynamicRange } from '../shared/codec';
import type { RoleType } from '../shared/role-type';

export type DashTrackType = 'video' | 'audio' | 'subtitle';

export type DashEncryptionData = {
  method: string;
  key?: Uint8Array;
  iv?: Uint8Array;
  drm: {
    widevine?: { keyId?: string; pssh?: string };
    playready?: { keyId?: string; pssh?: string };
    fairplay?: { keyId?: string; pssh?: string };
  };
};

export type DashParsedSegment = {
  sequenceNumber: number | null;
  duration: number;
  url: string;
  startRange?: number;
  expectLength?: number;
  encryption: DashEncryptionData | null;
  nameFromVar?: string;
};

export type DashSegmentState = {
  isLive: boolean;
  refreshIntervalMs: number;
  initSegment: DashParsedSegment | null;
  mediaSegments: DashParsedSegment[];
};

type DashTrackCommon = {
  type: DashTrackType;
  codec?: MediaCodec;
  codecString: string | null;
  manifestUrl: string;
  originalUrl: string;
  languageCode?: string;
  peakBitrate: number | null;
  averageBitrate: number | null;
  name: string | null;
  default: boolean;
  role?: RoleType;
  publishTime?: Date;
  groupId: string | null;
  audioGroupId?: string;
  subtitleGroupId?: string;
  periodId: string | null;
  extension: string | null;
  segmentState: DashSegmentState;
};

export type DashParsedVideoTrack = DashTrackCommon & {
  type: 'video';
  width?: number;
  height?: number;
  frameRate?: number;
  dynamicRange?: VideoDynamicRange;
};

export type DashParsedAudioTrack = DashTrackCommon & {
  type: 'audio';
  numberOfChannels?: number;
  sampleRate?: number;
  descriptive?: boolean;
  joc?: number;
};

export type DashParsedSubtitleTrack = DashTrackCommon & {
  type: 'subtitle';
  cc?: boolean;
  sdh?: boolean;
  forced?: boolean;
};

export type DashParsedTrack = DashParsedVideoTrack | DashParsedAudioTrack | DashParsedSubtitleTrack;

export const getDashTrackSegmentsCount = (track: DashParsedTrack) =>
  track.segmentState.mediaSegments.length;

export const getDashTrackDuration = (track: DashParsedTrack) =>
  track.segmentState.mediaSegments.reduce((sum, segment) => sum + segment.duration, 0);

export const getDashTrackMatchKey = (track: DashParsedTrack) =>
  JSON.stringify({
    type: track.type,
    codecString: track.codecString,
    groupId: track.groupId,
    periodId: track.periodId,
    width: track.type === 'video' ? track.width : null,
    height: track.type === 'video' ? track.height : null,
    languageCode: track.languageCode ?? null,
    name: track.name,
    role: track.role ?? null,
    extension: track.extension,
  });
