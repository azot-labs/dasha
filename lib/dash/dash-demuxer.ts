import { InputFormat } from 'mediabunny';
import type {
  AudioCodec,
  EncodedPacket,
  Input as MediabunnyInput,
  MediaCodec,
  MetadataTags,
  PacketType,
  Source,
  TrackDisposition,
  VideoCodec,
} from 'mediabunny';
import { ParserConfig } from '../parser-config';
import { ROLE_TYPE } from '../shared/role-type';
import type {
  AudioStreamInfo,
  MediaStreamInfo,
  SubtitleStreamInfo,
  VideoStreamInfo,
} from '../shared/stream-info';
import { DashExtractor } from './dash-extractor';
import {
  DashSegmentedInput,
  playlistToDashSegments,
  type DashSegment,
  type DashSegmentSource,
} from './dash-segmented-input';
import {
  DASH_MIME_TYPE,
  getSourceHeaders,
  isDashManifestText,
  isLikelyDashPath,
  loadDashManifest,
} from './dash-misc';

export type { DashSegment } from './dash-segmented-input';
export { DashSegmentedInput } from './dash-segmented-input';

const DEFAULT_DISPOSITION: TrackDisposition = {
  default: true,
  primary: true,
  forced: false,
  original: false,
  commentary: false,
  hearingImpaired: false,
  visuallyImpaired: false,
};

const getDisposition = (streamInfo: MediaStreamInfo): TrackDisposition => {
  const subtitleStreamInfo =
    streamInfo.type === 'subtitle' ? (streamInfo as SubtitleStreamInfo) : undefined;
  const audioStreamInfo = streamInfo.type === 'audio' ? (streamInfo as AudioStreamInfo) : undefined;

  return {
    ...DEFAULT_DISPOSITION,
    default: !!streamInfo.default,
    commentary: streamInfo.role === ROLE_TYPE.Commentary,
    hearingImpaired: !!subtitleStreamInfo?.sdh,
    visuallyImpaired: !!audioStreamInfo?.descriptive,
    forced: streamInfo.role === ROLE_TYPE.ForcedSubtitle || !!subtitleStreamInfo?.forced,
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
  extractor: DashExtractor;
  manifestUrl: string;
  streams: MediaStreamInfo[];
  trackBackings: DashInputTrackBacking[];
};

class DashSession {
  readonly source: Source;

  #loadPromise?: Promise<LoadedDashSession>;
  #disposed = false;

  constructor(source: Source) {
    this.source = source;
  }

  async load(): Promise<LoadedDashSession> {
    if (this.#disposed) {
      throw new Error('Input has been disposed.');
    }

    this.#loadPromise ??= (async () => {
      const { text, url } = await loadDashManifest(this.source);
      const parserConfig = new ParserConfig();
      parserConfig.headers = getSourceHeaders(this.source);
      parserConfig.originalUrl = url;
      parserConfig.url = url;

      const extractor = new DashExtractor(parserConfig);
      const streams = await extractor.extractStreams(text.trim());
      await extractor.fetchPlayList(streams);

      const typeNumbers = {
        video: 1,
        audio: 1,
        subtitle: 1,
      };
      const pairingMasks = createPairingMasks(streams);
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
        } else if (stream.type === 'subtitle') {
          trackBackings.push(
            new DashInputSubtitleTrackBacking(this, stream, index + 1, number, pairingMask),
          );
        }
      }

      return {
        extractor,
        manifestUrl: url,
        streams,
        trackBackings,
      };
    })();

    return this.#loadPromise;
  }

  async refreshSegments(streamInfo: MediaStreamInfo): Promise<void> {
    const { extractor, manifestUrl, streams } = await this.load();
    if (!streamInfo.playlist?.isLive) return;
    if (!manifestUrl.startsWith('http://') && !manifestUrl.startsWith('https://')) return;

    await extractor.refreshPlayList(streams);
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

class DashDemuxer {
  input: MediabunnyInput;

  #session: DashSession;

  constructor(input: MediabunnyInput) {
    this.input = input;
    this.#session = new DashSession(input.source);
  }

  async getTrackBackings() {
    const { trackBackings } = await this.#session.load();
    return trackBackings;
  }

  async getMimeType() {
    return DASH.mimeType;
  }

  async getMetadataTags(): Promise<MetadataTags> {
    return {};
  }

  dispose() {
    this.#session.dispose();
  }
}

export class DashInputFormat extends InputFormat {
  get name() {
    return 'dash';
  }

  get mimeType() {
    return DASH_MIME_TYPE;
  }

  async _canReadInput(input: MediabunnyInput) {
    if (isLikelyDashPath(input.source)) return true;

    try {
      const { text } = await loadDashManifest(input.source);
      return isDashManifestText(text);
    } catch {
      return false;
    }
  }

  _createDemuxer(input: MediabunnyInput) {
    return new DashDemuxer(input);
  }
}

export type DashInputSubtitleTrack = {
  readonly type: 'subtitle';
  getCodec(): Promise<MediaCodec | null>;
  getCodecParameterString(): Promise<string | null>;
  getSegmentedInput(): DashSegmentedInput;
  getSegments(): Promise<DashSegment[]>;
  isVideoTrack(): false;
  isAudioTrack(): false;
  determinePacketType(packet: EncodedPacket): Promise<PacketType | null>;
};

export const DASH = new DashInputFormat();
export const DASH_FORMATS: InputFormat[] = [DASH];
