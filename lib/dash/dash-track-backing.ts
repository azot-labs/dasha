import type {
  AudioCodec,
  EncodedPacket,
  MediaCodec,
  Source,
  TrackDisposition,
  VideoCodec,
} from 'mediabunny';
import { ROLE_TYPE } from '../shared/role-type';
import type {
  AudioStreamInfo,
  MediaStreamInfo,
  SubtitleStreamInfo,
  VideoStreamInfo,
} from '../shared/stream-info';
import { DashManifestParser } from './dash-manifest-parser';
import { DASH_MIME_TYPE, getSourceHeaders, loadDashManifest } from './dash-misc';
import {
  DashSegmentedInput,
  playlistToDashSegments,
  type DashSegmentSource,
} from './dash-segmented-input';

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

type LoadedDashSession = {
  parser: DashManifestParser;
  streams: MediaStreamInfo[];
  trackBackings: DashInputTrackBacking[];
};

export class DashSession {
  readonly source: Source;

  #disposed = false;
  #loadPromise?: Promise<LoadedDashSession>;

  constructor(source: Source) {
    this.source = source;
  }

  async load(): Promise<LoadedDashSession> {
    if (this.#disposed) {
      throw new Error('Input has been disposed.');
    }

    this.#loadPromise ??= (async () => {
      const { text, url } = await loadDashManifest(this.source);
      const parser = new DashManifestParser({
        headers: getSourceHeaders(this.source),
        originalUrl: url,
        url,
      });
      const streams = await parser.extractStreams(text.trim());
      const pairingMasks = createPairingMasks(streams);
      const typeNumbers = { audio: 1, subtitle: 1, video: 1 };
      const trackBackings: DashInputTrackBacking[] = [];

      for (const [index, stream] of streams.entries()) {
        const number = typeNumbers[stream.type]++;
        const pairingMask = pairingMasks.get(stream) ?? 0n;

        if (stream.type === 'video') {
          trackBackings.push(
            new DashInputVideoTrackBacking(this, stream, index + 1, number, pairingMask),
          );
        } else if (stream.type === 'audio') {
          trackBackings.push(
            new DashInputAudioTrackBacking(this, stream, index + 1, number, pairingMask),
          );
        } else {
          trackBackings.push(
            new DashInputSubtitleTrackBacking(this, stream, index + 1, number, pairingMask),
          );
        }
      }

      return { parser, streams, trackBackings };
    })();

    return this.#loadPromise;
  }

  async refreshSegments(streamInfo: MediaStreamInfo): Promise<void> {
    const { parser, streams } = await this.load();
    if (!streamInfo.playlist?.isLive) return;
    if (!parser.manifestUrl.startsWith('http://') && !parser.manifestUrl.startsWith('https://')) {
      return;
    }

    await parser.refreshPlaylist(streams);
  }

  dispose() {
    this.#disposed = true;
  }
}

abstract class DashTrackBacking implements DashSegmentSource {
  readonly session: DashSession;
  readonly streamInfo: MediaStreamInfo;

  #segmentedInput?: DashSegmentedInput;

  constructor(
    session: DashSession,
    streamInfo: MediaStreamInfo,
    private readonly id: number,
    private readonly number: number,
    private readonly pairingMask: bigint,
  ) {
    this.session = session;
    this.streamInfo = streamInfo;
  }

  abstract getType(): 'video' | 'audio' | 'subtitle';

  getId() {
    return this.id;
  }

  getNumber() {
    return this.number;
  }

  getCodec(): MediaCodec | null {
    return this.streamInfo.codec as MediaCodec | null;
  }

  getInternalCodecId() {
    return null;
  }

  getName() {
    return this.streamInfo.name ?? null;
  }

  getLanguageCode() {
    return this.streamInfo.languageCode ?? 'und';
  }

  getTimeResolution() {
    return 1;
  }

  isRelativeToUnixEpoch() {
    return false;
  }

  getDisposition() {
    return getDisposition(this.streamInfo);
  }

  getPairingMask() {
    return this.pairingMask;
  }

  getBitrate() {
    return this.streamInfo.bitrate ?? null;
  }

  getAverageBitrate() {
    return this.streamInfo.bitrate ?? null;
  }

  async getDurationFromMetadata() {
    return this.streamInfo.playlist?.totalDuration ?? null;
  }

  async getLiveRefreshInterval() {
    if (!this.streamInfo.playlist?.isLive) return null;
    return this.streamInfo.playlist.refreshIntervalMs / 1000;
  }

  async refreshSegments(streamInfo: MediaStreamInfo) {
    await this.session.refreshSegments(streamInfo);
  }

  getHasOnlyKeyPackets() {
    return false;
  }

  async getDecoderConfig() {
    return null;
  }

  getMetadataCodecParameterString() {
    return this.streamInfo.codecs;
  }

  async getFirstPacket() {
    return null;
  }

  async getPacket() {
    return null;
  }

  async getNextPacket(_packet: EncodedPacket) {
    return null;
  }

  async getKeyPacket() {
    return null;
  }

  async getNextKeyPacket(_packet: EncodedPacket) {
    return null;
  }

  getSegmentedInput() {
    this.#segmentedInput ??= new DashSegmentedInput(this);
    return this.#segmentedInput;
  }

  async getSegments() {
    const segmentedInput = this.getSegmentedInput();
    await segmentedInput.runUpdateSegments();
    return segmentedInput.segments;
  }

  toSegments() {
    return playlistToDashSegments(this.streamInfo.playlist);
  }
}

class DashInputVideoTrackBacking extends DashTrackBacking {
  override streamInfo: VideoStreamInfo;

  constructor(
    session: DashSession,
    streamInfo: VideoStreamInfo,
    id: number,
    number: number,
    pairingMask: bigint,
  ) {
    super(session, streamInfo, id, number, pairingMask);
    this.streamInfo = streamInfo;
  }

  getType() {
    return 'video' as const;
  }

  override getCodec(): VideoCodec | null {
    return this.streamInfo.codec as VideoCodec | null;
  }

  getCodedWidth() {
    return this.streamInfo.width ?? 0;
  }

  getCodedHeight() {
    return this.streamInfo.height ?? 0;
  }

  getSquarePixelWidth() {
    return this.streamInfo.width ?? 0;
  }

  getSquarePixelHeight() {
    return this.streamInfo.height ?? 0;
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

class DashInputAudioTrackBacking extends DashTrackBacking {
  override streamInfo: AudioStreamInfo;

  constructor(
    session: DashSession,
    streamInfo: AudioStreamInfo,
    id: number,
    number: number,
    pairingMask: bigint,
  ) {
    super(session, streamInfo, id, number, pairingMask);
    this.streamInfo = streamInfo;
  }

  getType() {
    return 'audio' as const;
  }

  override getCodec(): AudioCodec | null {
    return this.streamInfo.codec as AudioCodec | null;
  }

  getNumberOfChannels() {
    return this.streamInfo.numberOfChannels ?? 0;
  }

  getSampleRate() {
    return this.streamInfo.sampleRate ?? 0;
  }
}

class DashInputSubtitleTrackBacking extends DashTrackBacking {
  override streamInfo: SubtitleStreamInfo;

  constructor(
    session: DashSession,
    streamInfo: SubtitleStreamInfo,
    id: number,
    number: number,
    pairingMask: bigint,
  ) {
    super(session, streamInfo, id, number, pairingMask);
    this.streamInfo = streamInfo;
  }

  getType() {
    return 'subtitle' as const;
  }
}

export type DashInputTrackBacking =
  | DashInputVideoTrackBacking
  | DashInputAudioTrackBacking
  | DashInputSubtitleTrackBacking;

export { DASH_MIME_TYPE };
