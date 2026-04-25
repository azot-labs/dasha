import type {
  AudioCodec,
  DurationMetadataRequestOptions,
  EncodedPacket,
  MediaCodec,
  PacketRetrievalOptions,
  TrackDisposition,
  VideoCodec,
} from 'mediabunny';
import { ROLE_TYPE } from '../shared/role-type';
import type { AudioStreamInfo, MediaStreamInfo, SubtitleStreamInfo } from '../shared/stream-info';
import { DashSegmentedInput, type DashSegment } from './dash-segmented-input';

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

export type DashTrackOwner = {
  internalTracks: DashInternalTrack[] | null;
  getSegmentedInputForTrack(track: DashInternalTrack): DashSegmentedInput;
  refreshTrackSegments(track: DashInternalTrack): Promise<void>;
};

export type DashInternalTrack = {
  id: number;
  demuxer: DashTrackOwner;
  default: boolean;
  languageCode: string;
  fullCodecString: string | null;
  pairingMask: bigint;
  peakBitrate: number | null;
  averageBitrate: number | null;
  name: string | null;
  streamInfo: MediaStreamInfo;
  info: DashTrackInfo;
};

const DEFAULT_DISPOSITION: TrackDisposition = {
  commentary: false,
  default: true,
  forced: false,
  hearingImpaired: false,
  original: false,
  primary: true,
  visuallyImpaired: false,
};

const getDisposition = (streamInfo: MediaStreamInfo): TrackDisposition => {
  const subtitleStreamInfo =
    streamInfo.type === 'subtitle' ? (streamInfo as SubtitleStreamInfo) : undefined;
  const audioStreamInfo = streamInfo.type === 'audio' ? (streamInfo as AudioStreamInfo) : undefined;

  return {
    ...DEFAULT_DISPOSITION,
    commentary: streamInfo.role === ROLE_TYPE.Commentary,
    default: !!streamInfo.default,
    forced: streamInfo.role === ROLE_TYPE.ForcedSubtitle || !!subtitleStreamInfo?.forced,
    hearingImpaired: !!subtitleStreamInfo?.sdh,
    visuallyImpaired: !!audioStreamInfo?.descriptive,
  };
};

const canPairStreams = (left: MediaStreamInfo, right: MediaStreamInfo) => {
  if (left === right || left.type === right.type) return false;

  if (left.type === 'video' && right.type === 'audio') {
    return !left.audioId || left.audioId === right.groupId;
  }

  if (left.type === 'audio' && right.type === 'video') {
    return !right.audioId || right.audioId === left.groupId;
  }

  if (left.type === 'video' && right.type === 'subtitle') {
    return !left.subtitleId || left.subtitleId === right.groupId;
  }

  if (left.type === 'subtitle' && right.type === 'video') {
    return !right.subtitleId || right.subtitleId === left.groupId;
  }

  return false;
};

const createPairingMasks = (streams: MediaStreamInfo[]) => {
  const masks = new Map<MediaStreamInfo, bigint>();
  let nextPairIndex = 0;

  for (const [leftIndex, left] of streams.entries()) {
    for (const right of streams.slice(leftIndex + 1)) {
      if (!canPairStreams(left, right)) continue;

      const bit = 1n << BigInt(nextPairIndex++);
      masks.set(left, (masks.get(left) ?? 0n) | bit);
      masks.set(right, (masks.get(right) ?? 0n) | bit);
    }
  }

  return masks;
};

const createTrackInfo = (streamInfo: MediaStreamInfo): DashTrackInfo => {
  if (streamInfo.type === 'video') {
    return {
      type: 'video',
      width: streamInfo.width ?? null,
      height: streamInfo.height ?? null,
    };
  }

  if (streamInfo.type === 'audio') {
    return {
      type: 'audio',
      numberOfChannels: streamInfo.numberOfChannels ?? null,
    };
  }

  return {
    type: 'subtitle',
  };
};

export const createDashInternalTracks = (
  demuxer: DashTrackOwner,
  streams: MediaStreamInfo[],
): DashInternalTrack[] => {
  const pairingMasks = createPairingMasks(streams);

  return streams.map((streamInfo, index) => ({
    id: index + 1,
    demuxer,
    default: !!streamInfo.default,
    languageCode: streamInfo.languageCode ?? 'und',
    fullCodecString: streamInfo.codecs,
    pairingMask: pairingMasks.get(streamInfo) ?? 0n,
    peakBitrate: streamInfo.bitrate ?? null,
    averageBitrate: streamInfo.bitrate ?? null,
    name: streamInfo.name ?? null,
    streamInfo,
    info: createTrackInfo(streamInfo),
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

abstract class DashBaseTrackBacking {
  constructor(readonly internalTrack: DashInternalTrack) {}

  abstract getType(): 'video' | 'audio' | 'subtitle';

  getId() {
    return this.internalTrack.id;
  }

  getNumber() {
    return getTrackNumber(this.internalTrack);
  }

  getCodec(): MediaCodec | null {
    return this.internalTrack.streamInfo.codec as MediaCodec | null;
  }

  getInternalCodecId() {
    return null;
  }

  getName() {
    return this.internalTrack.name;
  }

  getLanguageCode() {
    return this.internalTrack.languageCode;
  }

  getTimeResolution() {
    return 1;
  }

  isRelativeToUnixEpoch() {
    return false;
  }

  getDisposition() {
    return getDisposition(this.internalTrack.streamInfo);
  }

  getPairingMask() {
    return this.internalTrack.pairingMask;
  }

  getBitrate() {
    return this.internalTrack.peakBitrate;
  }

  getAverageBitrate() {
    return this.internalTrack.averageBitrate;
  }

  async getDurationFromMetadata(_options: DurationMetadataRequestOptions) {
    return this.internalTrack.streamInfo.playlist?.totalDuration ?? null;
  }

  async getLiveRefreshInterval() {
    const playlist = this.internalTrack.streamInfo.playlist;
    if (!playlist?.isLive) return null;
    return playlist.refreshIntervalMs / 1000;
  }

  getHasOnlyKeyPackets() {
    return false;
  }

  async getDecoderConfig() {
    return null;
  }

  getMetadataCodecParameterString() {
    return this.internalTrack.fullCodecString;
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

class DashInputVideoTrackBacking extends DashBaseTrackBacking {
  override internalTrack: DashInternalTrack & { info: Extract<DashTrackInfo, { type: 'video' }> };

  constructor(
    internalTrack: DashInternalTrack & { info: Extract<DashTrackInfo, { type: 'video' }> },
  ) {
    super(internalTrack);
    this.internalTrack = internalTrack;
  }

  getType() {
    return 'video' as const;
  }

  override getCodec(): VideoCodec | null {
    return this.internalTrack.streamInfo.codec as VideoCodec | null;
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

class DashInputAudioTrackBacking extends DashBaseTrackBacking {
  override internalTrack: DashInternalTrack & { info: Extract<DashTrackInfo, { type: 'audio' }> };

  constructor(
    internalTrack: DashInternalTrack & { info: Extract<DashTrackInfo, { type: 'audio' }> },
  ) {
    super(internalTrack);
    this.internalTrack = internalTrack;
  }

  getType() {
    return 'audio' as const;
  }

  override getCodec(): AudioCodec | null {
    return this.internalTrack.streamInfo.codec as AudioCodec | null;
  }

  getNumberOfChannels() {
    return this.internalTrack.info.numberOfChannels ?? 0;
  }

  getSampleRate() {
    return (this.internalTrack.streamInfo as AudioStreamInfo).sampleRate ?? 0;
  }
}

class DashInputSubtitleTrackBacking extends DashBaseTrackBacking {
  getType() {
    return 'subtitle' as const;
  }
}

export const createDashTrackBackings = (internalTracks: DashInternalTrack[]) =>
  internalTracks.map((internalTrack) => {
    if (internalTrack.info.type === 'video') {
      return new DashInputVideoTrackBacking(
        internalTrack as DashInternalTrack & { info: Extract<DashTrackInfo, { type: 'video' }> },
      );
    }
    if (internalTrack.info.type === 'audio') {
      return new DashInputAudioTrackBacking(
        internalTrack as DashInternalTrack & { info: Extract<DashTrackInfo, { type: 'audio' }> },
      );
    }
    return new DashInputSubtitleTrackBacking(internalTrack);
  });

export type DashInputTrackBacking =
  | DashInputVideoTrackBacking
  | DashInputAudioTrackBacking
  | DashInputSubtitleTrackBacking;
