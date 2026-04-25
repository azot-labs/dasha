import type {
  AudioCodec,
  DurationMetadataRequestOptions,
  EncodedPacket,
  MediaCodec,
  PacketRetrievalOptions,
  TrackDisposition,
  VideoCodec,
} from 'mediabunny';
import { ROLE_TYPE } from '../role-type';
import {
  type DashParsedAudioTrack,
  type DashParsedTrack,
  type DashParsedVideoTrack,
} from './dash-misc';
import type { DashDemuxer } from './dash-demuxer';
import type { DashSegment } from './dash-segmented-input';

type DashTrackInfo =
  | {
      type: 'video';
      width: number | null;
      height: number | null;
    }
  | {
      type: 'audio';
      numberOfChannels: number | null;
    }
  | {
      type: 'subtitle';
    };

export type DashInternalTrack = {
  id: number;
  demuxer: DashDemuxer;
  backingTrack: DashInputTrackBacking | null;
  pairingMask: bigint;
  track: DashParsedTrack;
  info: DashTrackInfo;
};

const DEFAULT_TRACK_DISPOSITION: TrackDisposition = {
  commentary: false,
  default: true,
  forced: false,
  hearingImpaired: false,
  original: false,
  primary: true,
  visuallyImpaired: false,
};

const getDisposition = (track: DashParsedTrack): TrackDisposition => {
  return {
    ...DEFAULT_TRACK_DISPOSITION,
    commentary: track.role === ROLE_TYPE.Commentary,
    default: !!track.default,
    forced:
      track.role === ROLE_TYPE.ForcedSubtitle || !!(track.type === 'subtitle' && track.forced),
    hearingImpaired: !!(track.type === 'subtitle' && track.sdh),
    visuallyImpaired: !!(track.type === 'audio' && track.descriptive),
  };
};

const canPairTracks = (left: DashParsedTrack, right: DashParsedTrack) => {
  if (left === right || left.type === right.type) return false;

  if (left.type === 'video' && right.type === 'audio') {
    return !left.audioGroupId || left.audioGroupId === right.groupId;
  }

  if (left.type === 'audio' && right.type === 'video') {
    return !right.audioGroupId || right.audioGroupId === left.groupId;
  }

  if (left.type === 'video' && right.type === 'subtitle') {
    return !left.subtitleGroupId || left.subtitleGroupId === right.groupId;
  }

  if (left.type === 'subtitle' && right.type === 'video') {
    return !right.subtitleGroupId || right.subtitleGroupId === left.groupId;
  }

  return false;
};

const createPairingMasks = (tracks: DashParsedTrack[]) => {
  const masks = new Map<DashParsedTrack, bigint>();
  let nextPairIndex = 0;

  for (const [leftIndex, left] of tracks.entries()) {
    for (const right of tracks.slice(leftIndex + 1)) {
      if (!canPairTracks(left, right)) continue;

      const bit = 1n << BigInt(nextPairIndex++);
      masks.set(left, (masks.get(left) ?? 0n) | bit);
      masks.set(right, (masks.get(right) ?? 0n) | bit);
    }
  }

  return masks;
};

const createTrackInfo = (track: DashParsedTrack): DashTrackInfo => {
  if (track.type === 'video') {
    return {
      type: 'video',
      width: track.width ?? null,
      height: track.height ?? null,
    };
  }

  if (track.type === 'audio') {
    return {
      type: 'audio',
      numberOfChannels: track.numberOfChannels ?? null,
    };
  }

  return {
    type: 'subtitle',
  };
};

export const createDashInternalTracks = (
  demuxer: DashDemuxer,
  tracks: DashParsedTrack[],
): DashInternalTrack[] => {
  const pairingMasks = createPairingMasks(tracks);

  return tracks.map((track, index) => ({
    id: index + 1,
    demuxer,
    backingTrack: null,
    pairingMask: pairingMasks.get(track) ?? 0n,
    track,
    info: createTrackInfo(track),
  }));
};

const getTrackNumber = (internalTrack: DashInternalTrack) => {
  const internalTracks = internalTrack.demuxer.internalTracks;
  if (!internalTracks) {
    return 1;
  }

  let number = 0;
  for (const track of internalTracks) {
    if (track.info.type === internalTrack.info.type) {
      number++;
    }
    if (track === internalTrack) {
      break;
    }
  }

  return number;
};

abstract class DashInputTrackBackingBase {
  internalTrack: DashInternalTrack;

  constructor(internalTrack: DashInternalTrack) {
    this.internalTrack = internalTrack;
  }

  abstract getType(): 'video' | 'audio' | 'subtitle';

  getId() {
    return this.internalTrack.id;
  }

  getNumber() {
    return getTrackNumber(this.internalTrack);
  }

  getCodec(): MediaCodec | null {
    return (this.internalTrack.track.codec as MediaCodec | undefined) ?? null;
  }

  getInternalCodecId() {
    return null;
  }

  getName() {
    return this.internalTrack.track.name;
  }

  getLanguageCode() {
    return this.internalTrack.track.languageCode ?? 'und';
  }

  getTimeResolution() {
    return 1;
  }

  isRelativeToUnixEpoch() {
    return false;
  }

  getDisposition() {
    return getDisposition(this.internalTrack.track);
  }

  getPairingMask() {
    return this.internalTrack.pairingMask;
  }

  getBitrate() {
    return this.internalTrack.track.peakBitrate;
  }

  getAverageBitrate() {
    return this.internalTrack.track.averageBitrate;
  }

  async getDurationFromMetadata(_options: DurationMetadataRequestOptions) {
    return this.internalTrack.track.segmentState.mediaSegments.reduce(
      (sum, segment) => sum + segment.duration,
      0,
    );
  }

  async getLiveRefreshInterval() {
    if (!this.internalTrack.track.segmentState.isLive) {
      return null;
    }
    return this.internalTrack.track.segmentState.refreshIntervalMs / 1000;
  }

  getHasOnlyKeyPackets() {
    return false;
  }

  async getDecoderConfig() {
    return null;
  }

  getMetadataCodecParameterString() {
    return this.internalTrack.track.codecString;
  }

  async getFirstPacket(_options: PacketRetrievalOptions) {
    return null;
  }

  async getPacket(_timestamp: number, _options: PacketRetrievalOptions) {
    return null;
  }

  async getNextPacket(_packet: EncodedPacket, _options: PacketRetrievalOptions) {
    return null;
  }

  async getKeyPacket(_timestamp: number, _options: PacketRetrievalOptions) {
    return null;
  }

  async getNextKeyPacket(_packet: EncodedPacket, _options: PacketRetrievalOptions) {
    return null;
  }

  getSegmentedInput() {
    return this.internalTrack.demuxer.getSegmentedInputForTrack(this.internalTrack);
  }

  async getSegments(): Promise<DashSegment[]> {
    const segmentedInput = this.getSegmentedInput();
    await segmentedInput.runUpdateSegments();
    return segmentedInput.segments;
  }
}

class DashInputVideoTrackBacking extends DashInputTrackBackingBase {
  override internalTrack: DashInternalTrack & {
    info: Extract<DashTrackInfo, { type: 'video' }>;
    track: DashParsedVideoTrack;
  };

  constructor(
    internalTrack: DashInternalTrack & {
      info: Extract<DashTrackInfo, { type: 'video' }>;
      track: DashParsedVideoTrack;
    },
  ) {
    super(internalTrack);
    this.internalTrack = internalTrack;
  }

  getType() {
    return 'video' as const;
  }

  override getCodec(): VideoCodec | null {
    return this.internalTrack.track.codec as VideoCodec | null;
  }

  getCodedWidth() {
    return this.internalTrack.info.width ?? 0;
  }

  getCodedHeight() {
    return this.internalTrack.info.height ?? 0;
  }

  getSquarePixelWidth() {
    return this.internalTrack.info.width ?? 0;
  }

  getSquarePixelHeight() {
    return this.internalTrack.info.height ?? 0;
  }

  getRotation() {
    return 0;
  }

  async getColorSpace(): Promise<VideoColorSpaceInit> {
    return {};
  }

  async canBeTransparent() {
    return false;
  }
}

class DashInputAudioTrackBacking extends DashInputTrackBackingBase {
  override internalTrack: DashInternalTrack & {
    info: Extract<DashTrackInfo, { type: 'audio' }>;
    track: DashParsedAudioTrack;
  };

  constructor(
    internalTrack: DashInternalTrack & {
      info: Extract<DashTrackInfo, { type: 'audio' }>;
      track: DashParsedAudioTrack;
    },
  ) {
    super(internalTrack);
    this.internalTrack = internalTrack;
  }

  getType() {
    return 'audio' as const;
  }

  override getCodec(): AudioCodec | null {
    return this.internalTrack.track.codec as AudioCodec | null;
  }

  getNumberOfChannels() {
    return this.internalTrack.info.numberOfChannels ?? 0;
  }

  getSampleRate() {
    return this.internalTrack.track.sampleRate ?? 0;
  }
}

class DashInputSubtitleTrackBacking extends DashInputTrackBackingBase {
  getType() {
    return 'subtitle' as const;
  }
}

export const createDashTrackBackings = (internalTracks: DashInternalTrack[]) =>
  internalTracks.map((internalTrack) => {
    let backing: DashInputTrackBacking;

    if (internalTrack.info.type === 'video') {
      backing = new DashInputVideoTrackBacking(
        internalTrack as DashInternalTrack & {
          info: Extract<DashTrackInfo, { type: 'video' }>;
          track: DashParsedVideoTrack;
        },
      );
    } else if (internalTrack.info.type === 'audio') {
      backing = new DashInputAudioTrackBacking(
        internalTrack as DashInternalTrack & {
          info: Extract<DashTrackInfo, { type: 'audio' }>;
          track: DashParsedAudioTrack;
        },
      );
    } else {
      backing = new DashInputSubtitleTrackBacking(internalTrack);
    }

    internalTrack.backingTrack = backing;
    return backing;
  });

export type DashInputTrackBacking =
  | DashInputVideoTrackBacking
  | DashInputAudioTrackBacking
  | DashInputSubtitleTrackBacking;
