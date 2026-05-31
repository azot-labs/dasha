import {
  HLS,
  ALL_FORMATS as ALL_MEDIABUNNY_FORMATS,
  Input as MediabunnyInput,
  InputTrack as MediabunnyInputTrack,
  InputVideoTrack as MediabunnyInputVideoTrackClass,
  SourceRef,
} from 'mediabunny';
import type {
  InputFormat,
  InputAudioTrack as MediabunnyInputAudioTrack,
  EncodedPacket,
  MediaCodec,
  PacketType,
  PathedSource,
  TrackDisposition,
  InputVideoTrack as MediabunnyInputVideoTrack,
  Source,
} from 'mediabunny';
import type { HlsSegment, HlsSegmentedInput, InputTrackWithBacking } from './mediabunny';
import type { DashSegment, DashSegmentedInput } from './dash/dash-segmented-input';
import { DASH } from './dash/dash-demuxer';
import { isLikelyDashPath } from './dash/dash-misc';
import type { InputTrackQuery } from 'mediabunny';
import {
  ExternalSubtitleTrackBacking,
  getHlsSubtitleTrackBackings,
  HlsSubtitleTrackBacking,
  type SourceWithRootPath,
} from './hls/hls-subtitles';
import type { SubtitleCodec, VideoDynamicRange } from './codec';
import { inferDynamicRange } from './video';

declare module 'mediabunny' {
  interface Input<S extends Source = Source> {
    _getDemuxer(): Promise<unknown>;
    _getTrackBackings(): Promise<unknown[]>;
    _wrapBackingAsTrack(backing: unknown): MediabunnyInputTrack;
  }
}

type SegmentAccessMethods = {
  getSegmentedInput(): HlsSegmentedInput | DashSegmentedInput;
  getSegments(): Promise<(HlsSegment | DashSegment)[]>;
  refreshSegments(): Promise<(HlsSegment | DashSegment)[]>;
};

type TrackMetadataOverrideMethods = {
  setLanguageCode(value: string): void;
};

type VideoDynamicRangeMethods = {
  getDynamicRange(): Promise<VideoDynamicRange>;
};

type MediabunnySubtitleTrackLike = MediabunnyInputTrack & {
  type: 'subtitle';
};

export type InputTrack = MediabunnyInputTrack & SegmentAccessMethods & TrackMetadataOverrideMethods;
export type InputVideoTrack = MediabunnyInputVideoTrack &
  SegmentAccessMethods &
  VideoDynamicRangeMethods &
  TrackMetadataOverrideMethods;
export type InputAudioTrack = MediabunnyInputAudioTrack &
  SegmentAccessMethods &
  TrackMetadataOverrideMethods;
export type InputSubtitleTrack = MediabunnySubtitleTrackLike &
  SegmentAccessMethods &
  TrackMetadataOverrideMethods;

export type InputSubtitleSource = PathedSource | SourceRef<PathedSource>;
export type InputSubtitleTrackMetadata = {
  codec?: SubtitleCodec | null;
  codecString?: string | null;
  disposition?: Partial<TrackDisposition>;
  languageCode?: string;
  name?: string | null;
  pairWith?: InputVideoTrack | Iterable<InputVideoTrack>;
};
export type InputAudioSource = Source | SourceRef<Source>;
export type InputAudioTrackPairing =
  | InputVideoTrack
  | Iterable<InputVideoTrack>
  | 'all'
  | 'primary'
  | false;
export type InputAudioTracksOptions = {
  filter?: InputTrackQuery<InputAudioTrack>['filter'];
  formats?: readonly InputFormat[];
  pairWith?: InputAudioTrackPairing;
  sortBy?: InputTrackQuery<InputAudioTrack>['sortBy'];
};

type InternalInput<S extends Source = Source> = MediabunnyInput<S> & {
  _getTrackBackings(): Promise<NativeTrackBacking[]>;
  _getSyntheticTrackBackings?(
    type?: typeof BACKING_TYPE_VIDEO | typeof BACKING_TYPE_AUDIO | typeof BACKING_TYPE_SUBTITLE,
  ): Promise<TrackBacking[]>;
  _sourceRefs: SourceRef[];
};

type SegmentableBacking = {
  getId(): number;
  getNumber(): number;
  getType(): string;
  getCodec(): MediaCodec | null | Promise<MediaCodec | null>;
  getInternalCodecId?():
    | string
    | number
    | Uint8Array
    | null
    | Promise<string | number | Uint8Array | null>;
  getName?(): string | null | Promise<string | null>;
  getLanguageCode?(): string | Promise<string>;
  getTimeResolution?(): number | Promise<number>;
  isRelativeToUnixEpoch?(): boolean | Promise<boolean>;
  getDisposition?(): unknown | Promise<unknown>;
  getPairingMask?(): bigint;
  getBitrate?(): number | null | Promise<number | null>;
  getAverageBitrate?(): number | null | Promise<number | null>;
  getDurationFromMetadata?(options: unknown): Promise<number | null>;
  getLiveRefreshInterval?(): Promise<number | null>;
  getDecoderConfig?(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;
  getMetadataCodecParameterString?(): string | null | Promise<string | null>;
  getSegmentedInput?(): HlsSegmentedInput | DashSegmentedInput;
};
type NativeTrackBacking = SegmentableBacking;
type TrackBacking = NativeTrackBacking | SegmentableBacking;

const CUSTOM_SUBTITLE_TRACK_ID_OFFSET = 1_000_000_000;
const CUSTOM_AUDIO_TRACK_ID_OFFSET = 2_000_000_000;
const CUSTOM_PAIRING_BIT_START = 1024n;
const EXTRA_PAIRING_MASK = Symbol.for('dasha.extra-pairing-mask');
const ORIGINAL_GET_PAIRING_MASK = Symbol.for('dasha.original-get-pairing-mask');
const TRACK_METADATA_OVERRIDES = Symbol.for('dasha.track-metadata-overrides');
const ORIGINAL_GET_LANGUAGE_CODE = Symbol.for('dasha.original-get-language-code');
const HLS_VARIANT_INF_LINE = '#EXT-X-STREAM-INF:';
const HLS_DEMUXER_PATCHED = Symbol.for('dasha.hls-demuxer-patched');
const HLS_DEMUXER_METADATA_PATCH = Symbol.for('dasha.hls-demuxer-metadata-patch');
const HLS_VIDEO_RANGE_APPLIED = Symbol.for('dasha.hls-video-range-applied');

type TrackMetadataOverrides = {
  languageCode?: string;
};

type OverridableTrackBacking = SegmentableBacking & {
  [TRACK_METADATA_OVERRIDES]?: TrackMetadataOverrides;
  [ORIGINAL_GET_LANGUAGE_CODE]?: NonNullable<SegmentableBacking['getLanguageCode']>;
};

class HlsAttributeList {
  #attributes: Record<string, string> = {};

  constructor(str: string) {
    let key = '';
    let value = '';
    let inValue = false;
    let inQuotes = false;

    for (const char of str) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === '=' && !inValue && !inQuotes) {
        inValue = true;
      } else if (char === ',' && !inQuotes) {
        if (key) {
          this.#attributes[key.trim().toLowerCase()] = value;
        }

        key = '';
        value = '';
        inValue = false;
      } else if (inValue) {
        value += char;
      } else {
        key += char;
      }
    }

    if (key) {
      this.#attributes[key.trim().toLowerCase()] = value;
    }
  }

  get(name: string) {
    return this.#attributes[name.toLowerCase()] ?? null;
  }
}

const extractHlsVideoRanges = (text: string) => {
  const lines = text.split(/\r?\n/);
  const videoRanges: (string | null)[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith(HLS_VARIANT_INF_LINE)) {
      continue;
    }

    const attributes = new HlsAttributeList(line.slice(HLS_VARIANT_INF_LINE.length));
    videoRanges.push(attributes.get('video-range'));
  }

  return videoRanges;
};

const getPairingMaskIndexes = (pairingMask: bigint) => {
  const indexes: number[] = [];
  let value = pairingMask;
  let index = 0;

  while (value > 0n) {
    if ((value & 1n) === 1n) {
      indexes.push(index);
    }
    value >>= 1n;
    index++;
  }

  return indexes;
};

const applyHlsVideoRangeMetadata = async (demuxer: {
  hasMasterPlaylist?: boolean;
  input?: { _reader?: { requestEntireFile(): Promise<Uint8Array | { data: Uint8Array } | null> } };
  internalTracks?:
    | {
        pairingMask: bigint;
        info: { type: string };
        videoRange?: string | null;
      }[]
    | null;
  [HLS_VIDEO_RANGE_APPLIED]?: boolean;
}) => {
  if (
    demuxer[HLS_VIDEO_RANGE_APPLIED] ||
    !demuxer.hasMasterPlaylist ||
    !demuxer.internalTracks?.length
  ) {
    demuxer[HLS_VIDEO_RANGE_APPLIED] = true;
    return;
  }

  const slice = await demuxer.input?._reader?.requestEntireFile();
  if (!slice) {
    demuxer[HLS_VIDEO_RANGE_APPLIED] = true;
    return;
  }

  const bytes = (
    slice instanceof Uint8Array ? slice : 'bytes' in slice ? slice.bytes : slice.data
  ) as Uint8Array;
  const videoRanges = extractHlsVideoRanges(new TextDecoder().decode(bytes));
  if (!videoRanges.length) {
    demuxer[HLS_VIDEO_RANGE_APPLIED] = true;
    return;
  }

  for (const track of demuxer.internalTracks) {
    if (track.info.type !== 'video') {
      continue;
    }

    const matchedRanges = getPairingMaskIndexes(track.pairingMask)
      .map((index) => videoRanges[index] ?? null)
      .filter((value): value is string => value != null);
    const uniqueRanges = [...new Set(matchedRanges)];

    track.videoRange = uniqueRanges.length === 1 ? uniqueRanges[0]! : null;
  }

  demuxer[HLS_VIDEO_RANGE_APPLIED] = true;
};

const patchHlsDemuxer = (demuxer: unknown) => {
  if (
    !(demuxer instanceof Object) ||
    !('readMetadata' in demuxer) ||
    typeof demuxer.readMetadata !== 'function' ||
    !('input' in demuxer) ||
    (demuxer as { [HLS_DEMUXER_PATCHED]?: boolean })[HLS_DEMUXER_PATCHED]
  ) {
    return demuxer;
  }

  const candidate = demuxer as {
    readMetadata(): Promise<unknown>;
    hasMasterPlaylist?: boolean;
    [HLS_DEMUXER_PATCHED]?: boolean;
    [HLS_DEMUXER_METADATA_PATCH]?: Promise<unknown>;
  };

  if (candidate.constructor?.name !== 'HlsDemuxer') {
    return demuxer;
  }

  const originalReadMetadata = candidate.readMetadata.bind(candidate);
  candidate.readMetadata = () => {
    if (candidate[HLS_DEMUXER_METADATA_PATCH]) {
      return candidate[HLS_DEMUXER_METADATA_PATCH]!;
    }

    const promise = Promise.resolve(originalReadMetadata()).then(() =>
      applyHlsVideoRangeMetadata(candidate),
    );
    candidate[HLS_DEMUXER_METADATA_PATCH] = promise.catch((error) => {
      if (candidate[HLS_DEMUXER_METADATA_PATCH] === promise) {
        candidate[HLS_DEMUXER_METADATA_PATCH] = undefined;
      }
      throw error;
    });
    return candidate[HLS_DEMUXER_METADATA_PATCH]!;
  };
  candidate[HLS_DEMUXER_PATCHED] = true;
  return demuxer;
};

const getDynamicRangeForTrack = async (
  track: MediabunnyInputVideoTrack,
): Promise<VideoDynamicRange> => {
  const backing = (
    track as MediabunnyInputVideoTrack & {
      _backing?: {
        internalTrack?: {
          track?: { dynamicRange?: VideoDynamicRange };
          videoRange?: string | null;
        };
      };
    }
  )._backing;
  const manifestDynamicRange = backing?.internalTrack?.track?.dynamicRange;
  if (manifestDynamicRange) {
    return manifestDynamicRange;
  }

  const codecString = await track.getCodecParameterString().catch(() => null);
  const videoRange = backing?.internalTrack?.videoRange ?? null;

  const fromMetadata = inferDynamicRange({
    codecs: codecString,
    videoRange,
  });
  if (fromMetadata !== 'sdr' || videoRange != null) {
    return fromMetadata;
  }

  return inferDynamicRange({
    codecs: codecString,
    colorSpace: await track.getColorSpace().catch(() => null),
    videoRange,
  });
};

const requireSync = <T>(value: T | Promise<T>, getterName: string, asyncName: string): T => {
  if (value instanceof Promise) {
    throw new Error(
      `'${getterName}' is not available synchronously for this track. Use '${asyncName}()' instead.`,
    );
  }
  return value;
};

const queryTracks = async <T extends MediabunnyInputTrack>(
  tracks: T[],
  query?: InputTrackQuery<T>,
): Promise<T[]> => {
  let matched = tracks;
  if (query?.filter) {
    const filterMatches = tracks.map((track) => query.filter!(track));
    const resolvedFilterMatches = await Promise.all(filterMatches);
    matched = tracks.filter((_, index) => resolvedFilterMatches[index]);
  }

  if (!query?.sortBy) {
    return matched;
  }

  const resolvedSortValues = await Promise.all(matched.map((track) => query.sortBy!(track)));
  return matched
    .map((track, index) => ({ track, sortValue: resolvedSortValues[index] }))
    .sort((left, right) => {
      const leftValues = Array.isArray(left.sortValue) ? left.sortValue : [left.sortValue];
      const rightValues = Array.isArray(right.sortValue) ? right.sortValue : [right.sortValue];
      const maxLength = Math.max(leftValues.length, rightValues.length);
      for (let index = 0; index < maxLength; index++) {
        const leftValue = leftValues[index] ?? 0;
        const rightValue = rightValues[index] ?? 0;
        if (leftValue === rightValue) {
          continue;
        }
        return leftValue - rightValue;
      }
      return 0;
    })
    .map(({ track }) => track);
};

const BACKING_TYPE_SUBTITLE = 'subtitle';
const BACKING_TYPE_AUDIO = 'audio';
const BACKING_TYPE_VIDEO = 'video';
const BASE_INPUT_PATCHED = Symbol.for('dasha.base-mediabunny-input-patched');
export const PRESERVE_SUBTITLE_BACKINGS = Symbol.for('dasha.preserve-subtitle-backings');

const getDefaultAudioTrackFormats = (source: InputAudioSource): InputFormat[] => {
  const rawSource = source instanceof SourceRef ? source.source : source;
  return isLikelyDashPath(rawSource)
    ? [DASH, ...ALL_MEDIABUNNY_FORMATS]
    : [...ALL_MEDIABUNNY_FORMATS, DASH];
};

class WholeResourceAudioSegmentedInput {
  segments: HlsSegment[] = [];
  #source: Source;

  constructor(source: Source) {
    this.#source = source;
  }

  async runUpdateSegments() {
    if (this.segments.length > 0) {
      return;
    }

    const sourceWithRootPath = this.#source as Source & { rootPath?: string };
    if (typeof sourceWithRootPath.rootPath !== 'string') {
      return;
    }

    const segment: HlsSegment = {
      timestamp: 0,
      duration: 0,
      relativeToUnixEpoch: false,
      firstSegment: null,
      sequenceNumber: 0,
      location: {
        path: sourceWithRootPath.rootPath,
        offset: 0,
        length: null,
      },
      encryption: null,
      initSegment: null,
      lastProgramDateTimeSeconds: null,
    };
    segment.firstSegment = segment;
    this.segments = [segment];
  }
}

class ImportedAudioTrackBacking {
  #backing: SegmentableBacking;
  #id: number;
  #number: number;
  #wholeResourceSegmentedInput: WholeResourceAudioSegmentedInput;

  constructor(params: { backing: SegmentableBacking; id: number; number: number; source: Source }) {
    this.#backing = params.backing;
    this.#id = params.id;
    this.#number = params.number;
    this.#wholeResourceSegmentedInput = new WholeResourceAudioSegmentedInput(params.source);
  }

  getType() {
    return BACKING_TYPE_AUDIO;
  }

  getId() {
    return this.#id;
  }

  getNumber() {
    return this.#number;
  }

  getCodec() {
    return this.#backing.getCodec();
  }

  getInternalCodecId() {
    return this.#backing.getInternalCodecId?.() ?? null;
  }

  getName() {
    return this.#backing.getName?.() ?? null;
  }

  getLanguageCode() {
    return this.#backing.getLanguageCode?.() ?? 'und';
  }

  getTimeResolution() {
    return this.#backing.getTimeResolution?.() ?? 1000;
  }

  isRelativeToUnixEpoch() {
    return this.#backing.isRelativeToUnixEpoch?.() ?? false;
  }

  getDisposition() {
    return this.#backing.getDisposition?.() ?? {};
  }

  getPairingMask() {
    return this.#backing.getPairingMask?.() ?? 0n;
  }

  getBitrate() {
    return this.#backing.getBitrate?.() ?? null;
  }

  getAverageBitrate() {
    return this.#backing.getAverageBitrate?.() ?? null;
  }

  getDurationFromMetadata(options: unknown) {
    return this.#backing.getDurationFromMetadata?.(options) ?? Promise.resolve(null);
  }

  getLiveRefreshInterval() {
    return this.#backing.getLiveRefreshInterval?.() ?? Promise.resolve(null);
  }

  getHasOnlyKeyPackets() {
    return true;
  }

  getDecoderConfig() {
    return this.#backing.getDecoderConfig?.() ?? Promise.resolve(null);
  }

  getMetadataCodecParameterString() {
    return this.#backing.getMetadataCodecParameterString?.() ?? null;
  }

  getNumberOfChannels() {
    return (
      (
        this.#backing as SegmentableBacking & { getNumberOfChannels?(): number | Promise<number> }
      ).getNumberOfChannels?.() ?? 0
    );
  }

  getSampleRate() {
    return (
      (
        this.#backing as SegmentableBacking & { getSampleRate?(): number | Promise<number> }
      ).getSampleRate?.() ?? 0
    );
  }

  getFirstPacket(options: unknown) {
    return (
      (
        this.#backing as SegmentableBacking & {
          getFirstPacket?(options: unknown): Promise<EncodedPacket | null>;
        }
      ).getFirstPacket?.(options) ?? Promise.resolve(null)
    );
  }

  getPacket(timestamp: number, options: unknown) {
    return (
      (
        this.#backing as SegmentableBacking & {
          getPacket?(timestamp: number, options: unknown): Promise<EncodedPacket | null>;
        }
      ).getPacket?.(timestamp, options) ?? Promise.resolve(null)
    );
  }

  getNextPacket(packet: EncodedPacket, options: unknown) {
    return (
      (
        this.#backing as SegmentableBacking & {
          getNextPacket?(packet: EncodedPacket, options: unknown): Promise<EncodedPacket | null>;
        }
      ).getNextPacket?.(packet, options) ?? Promise.resolve(null)
    );
  }

  getKeyPacket(timestamp: number, options: unknown) {
    return (
      (
        this.#backing as SegmentableBacking & {
          getKeyPacket?(timestamp: number, options: unknown): Promise<EncodedPacket | null>;
        }
      ).getKeyPacket?.(timestamp, options) ?? Promise.resolve(null)
    );
  }

  getNextKeyPacket(packet: EncodedPacket, options: unknown) {
    return (
      (
        this.#backing as SegmentableBacking & {
          getNextKeyPacket?(packet: EncodedPacket, options: unknown): Promise<EncodedPacket | null>;
        }
      ).getNextKeyPacket?.(packet, options) ?? Promise.resolve(null)
    );
  }

  getSegmentedInput() {
    if (this.#backing.getSegmentedInput) {
      return this.#backing.getSegmentedInput();
    }

    const hlsBacking = this.#backing as InputTrackWithBacking['_backing'];
    if (hlsBacking.internalTrack?.demuxer?.getSegmentedInputForPath) {
      return hlsBacking.internalTrack.demuxer.getSegmentedInputForPath(
        hlsBacking.internalTrack.fullPath,
      );
    }

    return this.#wholeResourceSegmentedInput;
  }
}

const getBackingType = (backing: TrackBacking) => (backing as SegmentableBacking).getType?.();

const queryWrappedTracks = <T extends MediabunnyInputTrack>(
  input: InternalInput,
  backings: TrackBacking[],
  query?: InputTrackQuery<T>,
) => {
  const tracks = backings.map((backing) => input._wrapBackingAsTrack(backing)) as T[];
  return queryTracks(tracks, query);
};

const getTrackBackingsByType = async (
  input: InternalInput,
  type?: typeof BACKING_TYPE_VIDEO | typeof BACKING_TYPE_AUDIO | typeof BACKING_TYPE_SUBTITLE,
) => {
  const nativeBackings = (await input._getTrackBackings()) as TrackBacking[];
  const syntheticBackings = ((await input._getSyntheticTrackBackings?.(type)) ??
    []) as TrackBacking[];
  const backings = [...nativeBackings, ...syntheticBackings];
  return type ? backings.filter((backing) => getBackingType(backing) === type) : backings;
};

const patchBaseMediabunnyInput = () => {
  const prototype = MediabunnyInput.prototype as typeof MediabunnyInput.prototype & {
    [BASE_INPUT_PATCHED]?: boolean;
  };

  if (prototype[BASE_INPUT_PATCHED]) {
    return;
  }

  prototype.getTracks = function (query?: InputTrackQuery<MediabunnyInputTrack>) {
    return getTrackBackingsByType(this as InternalInput).then((backings) =>
      queryWrappedTracks(
        this as InternalInput,
        (this as InternalInput & { [PRESERVE_SUBTITLE_BACKINGS]?: boolean })[
          PRESERVE_SUBTITLE_BACKINGS
        ]
          ? backings
          : backings.filter((backing) => getBackingType(backing) !== BACKING_TYPE_SUBTITLE),
        query,
      ),
    );
  };

  prototype.getAudioTracks = function (query?: InputTrackQuery<MediabunnyInputAudioTrack>) {
    return getTrackBackingsByType(this as InternalInput, BACKING_TYPE_AUDIO).then((backings) =>
      queryWrappedTracks(this as InternalInput, backings, query),
    );
  };

  const originalGetDemuxer = prototype._getDemuxer;
  prototype._getDemuxer = function () {
    return originalGetDemuxer.call(this).then((demuxer: unknown) => patchHlsDemuxer(demuxer));
  };

  prototype[BASE_INPUT_PATCHED] = true;
};

const getSegmentedInputForTrack = (
  track: MediabunnyInputTrack,
): HlsSegmentedInput | DashSegmentedInput => {
  const backing = getTrackBacking(track);
  if ('getSegmentedInput' in backing && typeof backing.getSegmentedInput === 'function') {
    return backing.getSegmentedInput();
  }

  const hlsBacking = backing as InputTrackWithBacking['_backing'];
  const internalTrack = hlsBacking.internalTrack;
  return internalTrack.demuxer.getSegmentedInputForPath(internalTrack.fullPath);
};

const getTrackBacking = (
  track: MediabunnyInputTrack,
): InputTrackWithBacking['_backing'] | SegmentableBacking =>
  (track as InputTrackWithBacking)._backing as
    | InputTrackWithBacking['_backing']
    | SegmentableBacking;

const getTrackMetadataOverrides = (backing: OverridableTrackBacking) =>
  (backing[TRACK_METADATA_OVERRIDES] ??= {});

const ensureLanguageCodeOverridePatch = (backing: SegmentableBacking) => {
  const patchedBacking = backing as OverridableTrackBacking;
  if (patchedBacking[ORIGINAL_GET_LANGUAGE_CODE]) {
    return patchedBacking;
  }

  const originalGetLanguageCode = backing.getLanguageCode?.bind(backing) ?? (() => 'und');
  patchedBacking[ORIGINAL_GET_LANGUAGE_CODE] = originalGetLanguageCode;
  Object.assign(backing, {
    getLanguageCode: () =>
      getTrackMetadataOverrides(patchedBacking).languageCode ??
      patchedBacking[ORIGINAL_GET_LANGUAGE_CODE]?.() ??
      'und',
  });
  return patchedBacking;
};

const setTrackLanguageCode = (track: MediabunnyInputTrack, value: string) => {
  getTrackMetadataOverrides(
    ensureLanguageCodeOverridePatch(getTrackBacking(track) as SegmentableBacking),
  ).languageCode = value;
};

const addSegmentAccess = <T extends MediabunnyInputTrack>(
  track: T,
): T & SegmentAccessMethods & TrackMetadataOverrideMethods =>
  new Proxy(track, {
    get(target, prop) {
      if (prop === 'getDynamicRange' && target instanceof MediabunnyInputVideoTrackClass) {
        return () => getDynamicRangeForTrack(target);
      }

      if (prop === 'setLanguageCode') {
        return (value: string) => setTrackLanguageCode(target, value);
      }

      if (prop === 'getSegmentedInput') {
        return () => getSegmentedInputForTrack(target);
      }

      if (prop === 'getSegments') {
        return async () => {
          const segmentedInput = getSegmentedInputForTrack(target);
          if (segmentedInput.segments.length === 0) {
            await segmentedInput.runUpdateSegments();
          }
          return segmentedInput.segments;
        };
      }

      if (prop === 'refreshSegments') {
        return async () => {
          const segmentedInput = getSegmentedInputForTrack(target);
          await segmentedInput.runUpdateSegments();
          return segmentedInput.segments;
        };
      }

      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T & SegmentAccessMethods & TrackMetadataOverrideMethods;

class MediabunnyInputSubtitleTrack extends MediabunnyInputTrack {
  #backing: SegmentableBacking;

  constructor(input: MediabunnyInput, backing: SegmentableBacking) {
    super();
    Object.assign(this, { input, _backing: backing });
    this.#backing = backing;
  }

  get type() {
    return 'subtitle' as const;
  }

  async getCodec() {
    return this.#backing.getCodec();
  }

  get codec() {
    return requireSync(this.#backing.getCodec(), 'codec', 'getCodec');
  }

  async getCodecParameterString() {
    return (await this.#backing.getMetadataCodecParameterString?.()) ?? null;
  }

  async canDecode() {
    return true;
  }

  async determinePacketType(_packet: EncodedPacket): Promise<PacketType | null> {
    return null;
  }

  async hasOnlyKeyPackets() {
    return true;
  }
}

patchBaseMediabunnyInput();

export const preserveSubtitleBackingsOnInput = (input: MediabunnyInput) => {
  Object.assign(input, {
    [PRESERVE_SUBTITLE_BACKINGS]: true,
  });
  return input;
};

export class SegmentedMediabunnyInput<S extends Source = Source> extends MediabunnyInput<S> {
  #trackCache = new WeakMap<MediabunnyInputTrack, InputTrack>();
  #subtitleTrackCache = new WeakMap<object, MediabunnyInputSubtitleTrack>();
  #hlsSubtitleBackingsPromise: Promise<HlsSubtitleTrackBacking[]> | null = null;
  #customSubtitleBackings: ExternalSubtitleTrackBacking[] = [];
  #customAudioBackings: ImportedAudioTrackBacking[] = [];
  #audioInputs: MediabunnyInput[] = [];
  #nextCustomSubtitleTrackId = CUSTOM_SUBTITLE_TRACK_ID_OFFSET;
  #nextCustomSubtitleTrackNumber = CUSTOM_SUBTITLE_TRACK_ID_OFFSET;
  #nextCustomAudioTrackId = CUSTOM_AUDIO_TRACK_ID_OFFSET;
  #nextCustomAudioTrackNumber = CUSTOM_AUDIO_TRACK_ID_OFFSET;
  #nextPairingBitIndex: bigint | null = null;

  async #queryTracks<T extends MediabunnyInputTrack>(
    query: InputTrackQuery<T> | undefined,
    type?: typeof BACKING_TYPE_VIDEO | typeof BACKING_TYPE_AUDIO | typeof BACKING_TYPE_SUBTITLE,
  ) {
    const internalInput = this as unknown as InternalInput<S>;
    const backings = await getTrackBackingsByType(internalInput, type);
    return queryWrappedTracks(internalInput, backings, query);
  }

  override _wrapBackingAsTrack(backing: TrackBacking): InputTrack {
    const track =
      (backing as SegmentableBacking).getType?.() === 'subtitle'
        ? this.#wrapSubtitleBacking(backing as SegmentableBacking)
        : super._wrapBackingAsTrack(backing);
    const existing = this.#trackCache.get(track);
    if (existing) return existing;

    const wrapped = addSegmentAccess(track);
    this.#trackCache.set(track, wrapped);
    return wrapped;
  }

  async _getSyntheticTrackBackings(
    type?: typeof BACKING_TYPE_VIDEO | typeof BACKING_TYPE_AUDIO | typeof BACKING_TYPE_SUBTITLE,
  ) {
    if (type === BACKING_TYPE_VIDEO) {
      return [];
    }

    const audioBackings = type !== BACKING_TYPE_SUBTITLE ? [...this.#customAudioBackings] : [];
    const backings = type !== BACKING_TYPE_AUDIO ? [...this.#customSubtitleBackings] : [];
    if (type === BACKING_TYPE_AUDIO) {
      return audioBackings;
    }

    if ((await this.getFormat()) !== HLS) {
      return [...audioBackings, ...backings];
    }

    if (!this.#hlsSubtitleBackingsPromise) {
      const promise = getHlsSubtitleTrackBackings(this).catch((error) => {
        if (this.#hlsSubtitleBackingsPromise === promise) {
          this.#hlsSubtitleBackingsPromise = null;
        }
        throw error;
      });
      this.#hlsSubtitleBackingsPromise = promise;
    }

    return [...audioBackings, ...backings, ...(await this.#hlsSubtitleBackingsPromise)];
  }

  #wrapSubtitleBacking(backing: SegmentableBacking) {
    const existing = this.#subtitleTrackCache.get(backing);
    if (existing) return existing;

    const track = new MediabunnyInputSubtitleTrack(this, backing);
    this.#subtitleTrackCache.set(backing, track);
    return track;
  }

  override async getTracks(query?: InputTrackQuery<InputTrack>) {
    return (await this.#queryTracks(query)) as InputTrack[];
  }

  override async getVideoTracks(query?: InputTrackQuery<InputVideoTrack>) {
    return (await this.#queryTracks(query, BACKING_TYPE_VIDEO)) as InputVideoTrack[];
  }

  override async getAudioTracks(query?: InputTrackQuery<InputAudioTrack>) {
    return (await this.#queryTracks(query, BACKING_TYPE_AUDIO)) as InputAudioTrack[];
  }

  async getSubtitleTracks(query?: InputTrackQuery<InputSubtitleTrack>) {
    return (await this.#queryTracks(query, BACKING_TYPE_SUBTITLE)) as InputSubtitleTrack[];
  }

  override async getPrimaryVideoTrack(query?: InputTrackQuery<InputVideoTrack>) {
    return (await super.getPrimaryVideoTrack(query as never)) as InputVideoTrack | null;
  }

  override async getPrimaryAudioTrack(query?: InputTrackQuery<InputAudioTrack>) {
    return (await super.getPrimaryAudioTrack(query as never)) as InputAudioTrack | null;
  }

  addSubtitleTrack(
    source: InputSubtitleSource,
    metadata: InputSubtitleTrackMetadata = {},
  ): InputSubtitleTrack {
    const pathedSource = this.#takeSubtitleSourceRef(source);
    const sourceWithRootPath = pathedSource.source as SourceWithRootPath;
    if (typeof sourceWithRootPath.rootPath !== 'string') {
      throw new TypeError('source must provide a string rootPath.');
    }

    const pairWith = this.#toPairableVideoTracks(metadata.pairWith);
    const backing = new ExternalSubtitleTrackBacking({
      id: this.#nextCustomSubtitleTrackId++,
      number: this.#nextCustomSubtitleTrackNumber++,
      pairingMask: 0n,
      source: sourceWithRootPath,
      codec: metadata.codec,
      codecString: metadata.codecString,
      disposition: metadata.disposition,
      languageCode: metadata.languageCode,
      name: metadata.name,
    });

    this.#pairSubtitleBacking(backing, pairWith);
    this.#customSubtitleBackings.push(backing);
    return this._wrapBackingAsTrack(backing) as InputSubtitleTrack;
  }

  async addAudioTracks(
    source: InputAudioSource,
    options: InputAudioTracksOptions = {},
  ): Promise<InputAudioTrack[]> {
    const audioInput = new SegmentedMediabunnyInput({
      source,
      formats: [...(options.formats ?? getDefaultAudioTrackFormats(source))],
    });
    this.#audioInputs.push(audioInput);

    const audioTracks = await audioInput.getAudioTracks({
      filter: options.filter,
      sortBy: options.sortBy,
    });
    const pairWith = await this.#getAudioPairingVideoTracks(options.pairWith);
    const importedTracks: InputAudioTrack[] = [];

    for (const audioTrack of audioTracks) {
      const backing = new ImportedAudioTrackBacking({
        id: this.#nextCustomAudioTrackId++,
        number: this.#nextCustomAudioTrackNumber++,
        backing: getTrackBacking(audioTrack) as SegmentableBacking,
        source: audioInput.source,
      });
      this.#pairAudioBacking(backing, pairWith);
      this.#customAudioBackings.push(backing);
      importedTracks.push(this._wrapBackingAsTrack(backing) as InputAudioTrack);
    }

    return importedTracks;
  }

  #takeSubtitleSourceRef(source: InputSubtitleSource) {
    const rawSource = source instanceof SourceRef ? source.source : source;
    if (
      !(rawSource instanceof Object) ||
      !('rootPath' in rawSource) ||
      !('ref' in rawSource) ||
      typeof rawSource.ref !== 'function'
    ) {
      throw new TypeError('source must be a pathed source such as UrlSource or FilePathSource.');
    }

    const ref = rawSource.ref() as SourceRef<PathedSource>;
    (this as unknown as InternalInput<S>)._sourceRefs.push(ref);
    return ref;
  }

  #toPairableVideoTracks(pairWith: InputVideoTrack | Iterable<InputVideoTrack> | undefined) {
    if (!pairWith) {
      return [];
    }

    const tracks = this.#isIterable(pairWith) ? [...pairWith] : [pairWith];
    for (const track of tracks) {
      if (track.input !== this) {
        throw new TypeError('pairWith tracks must belong to the same input instance.');
      }
      if (track.type !== 'video') {
        throw new TypeError('pairWith only accepts video tracks.');
      }
    }
    return tracks;
  }

  async #getAudioPairingVideoTracks(pairWith: InputAudioTrackPairing | undefined) {
    if (pairWith === false) {
      return [];
    }

    if (!pairWith || pairWith === 'all') {
      return this.getVideoTracks();
    }

    if (pairWith === 'primary') {
      const primaryVideoTrack = await this.getPrimaryVideoTrack();
      return primaryVideoTrack ? [primaryVideoTrack] : [];
    }

    return this.#toPairableVideoTracks(pairWith);
  }

  #isIterable<T>(value: Iterable<T> | T): value is Iterable<T> {
    return typeof value === 'object' && value !== null && Symbol.iterator in value;
  }

  #pairSubtitleBacking(
    subtitleBacking: ExternalSubtitleTrackBacking,
    videoTracks: InputVideoTrack[],
  ) {
    this.#pairBackingWithVideoTracks(subtitleBacking as TrackBacking, videoTracks);
  }

  #pairAudioBacking(audioBacking: ImportedAudioTrackBacking, videoTracks: InputVideoTrack[]) {
    this.#pairBackingWithVideoTracks(audioBacking as TrackBacking, videoTracks);
  }

  #pairBackingWithVideoTracks(backing: TrackBacking, videoTracks: InputVideoTrack[]) {
    for (const track of videoTracks) {
      const bit = this.#allocatePairingBit();
      this.#appendPairingMask(backing, bit);
      this.#appendPairingMask(
        (track as unknown as MediabunnyInputTrack & { _backing: TrackBacking })._backing,
        bit,
      );
    }
  }

  #allocatePairingBit() {
    const nextIndex = this.#nextPairingBitIndex ?? this.#getInitialPairingBitIndex();
    this.#nextPairingBitIndex = nextIndex + 1n;
    return 1n << nextIndex;
  }

  #getInitialPairingBitIndex() {
    const internalInput = this as unknown as InternalInput<S> & {
      _trackBackingsCache?: NativeTrackBacking[] | null;
    };
    const loadedBackings: TrackBacking[] = [...(internalInput._trackBackingsCache ?? [])];
    let maxBitIndex = -1n;

    for (const backing of [
      ...loadedBackings,
      ...this.#customSubtitleBackings,
      ...this.#customAudioBackings,
    ]) {
      const mask = backing.getPairingMask?.() ?? 0n;
      if (mask === 0n) {
        continue;
      }

      const bitIndex = BigInt(mask.toString(2).length - 1);
      if (bitIndex > maxBitIndex) {
        maxBitIndex = bitIndex;
      }
    }

    return maxBitIndex >= 0n ? maxBitIndex + 1n : CUSTOM_PAIRING_BIT_START;
  }

  #appendPairingMask(backing: TrackBacking, mask: bigint) {
    const patchedBacking = backing as TrackBacking & {
      [EXTRA_PAIRING_MASK]?: bigint;
      [ORIGINAL_GET_PAIRING_MASK]?: () => bigint;
    };

    patchedBacking[EXTRA_PAIRING_MASK] = (patchedBacking[EXTRA_PAIRING_MASK] ?? 0n) | mask;
    if (patchedBacking[ORIGINAL_GET_PAIRING_MASK]) {
      return;
    }

    const originalGetPairingMask = backing.getPairingMask?.bind(backing) ?? (() => 0n);
    patchedBacking[ORIGINAL_GET_PAIRING_MASK] = originalGetPairingMask;
    Object.assign(backing, {
      getPairingMask: () =>
        (patchedBacking[ORIGINAL_GET_PAIRING_MASK]?.() ?? 0n) |
        (patchedBacking[EXTRA_PAIRING_MASK] ?? 0n),
    });
  }

  override dispose() {
    if (this.disposed) {
      return;
    }

    super.dispose();
    for (const input of this.#audioInputs) {
      input.dispose();
    }
    this.#audioInputs.length = 0;
  }
}
