import {
  HLS,
  ALL_FORMATS as ALL_MEDIABUNNY_FORMATS,
  BufferSource,
  Input as MediabunnyInput,
  InputTrack as MediabunnyInputTrack,
  InputVideoTrack as MediabunnyInputVideoTrackClass,
  SourceRef,
  type InputTrackQuery,
  type InputFormat,
  type InputAudioTrack as MediabunnyInputAudioTrack,
  type EncodedPacket,
  type MediaCodec,
  type PacketType,
  type PathedSource,
  type TrackDisposition,
  type InputVideoTrack as MediabunnyInputVideoTrack,
  type InputOptions as MediabunnyInputOptions,
  type Source,
} from 'mediabunny';
import type { HlsSegment, HlsSegmentedInput, InputTrackWithBacking } from './mediabunny';
import type { DashSegment, DashSegmentedInput } from './dash/dash-segmented-input';
import { DASH } from './dash/dash-demuxer';
import { isLikelyDashPath, resolvePathedSourcePath } from './dash/dash-misc';
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
  setName(value: string | null): void;
};

type TrackSourceMethods = {
  readonly source: Source;
};

interface TrackOriginMethods {
  /**
   * The track in the input it comes from. For a track of a merged input (see `Input.merge`), the track of the
   * input it was merged from, with its original ID; otherwise the track itself. Typed as any track
   * kind, so narrowing with `isAudioTrack()` or `isVideoTrack()` still yields dasha's track types.
   */
  readonly origin: InputTrack;
}

type VideoDynamicRangeMethods = {
  getDynamicRange(): Promise<VideoDynamicRange>;
};

type MediabunnySubtitleTrackLike = MediabunnyInputTrack & {
  type: 'subtitle';
};

export type InputTrack = MediabunnyInputTrack &
  SegmentAccessMethods &
  TrackMetadataOverrideMethods &
  TrackSourceMethods &
  TrackOriginMethods;
export type InputVideoTrack = MediabunnyInputVideoTrack &
  SegmentAccessMethods &
  VideoDynamicRangeMethods &
  TrackMetadataOverrideMethods &
  TrackSourceMethods &
  TrackOriginMethods;
export type InputAudioTrack = MediabunnyInputAudioTrack &
  SegmentAccessMethods &
  TrackMetadataOverrideMethods &
  TrackSourceMethods &
  TrackOriginMethods;
export type InputSubtitleTrack = MediabunnySubtitleTrackLike &
  SegmentAccessMethods &
  TrackMetadataOverrideMethods &
  TrackSourceMethods &
  TrackOriginMethods;

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
  /** Marks the imported tracks as audio description tracks. */
  visuallyImpaired?: boolean;
  /** Overrides the track name (e.g. "Audio Description" for tracks imported from a separate manifest). */
  name?: string | null;
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
  segmentedInput?: HlsSegmentedInput;
  getSource?(): Source;
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
const ORIGINAL_GET_NAME = Symbol.for('dasha.original-get-name');
const ORIGIN_TRACK = Symbol.for('dasha.origin-track');
const MERGED_INPUT_HAS_NO_ROOT =
  'A merged input has no source or format of its own; read them from its tracks (track.source, track.origin.input).';
const HLS_VARIANT_INF_LINE = '#EXT-X-STREAM-INF:';
const HLS_DEMUXER_PATCHED = Symbol.for('dasha.hls-demuxer-patched');
const HLS_DEMUXER_METADATA_PATCH = Symbol.for('dasha.hls-demuxer-metadata-patch');
const HLS_VIDEO_RANGE_APPLIED = Symbol.for('dasha.hls-video-range-applied');

type TrackMetadataOverrides = {
  languageCode?: string;
  name?: string | null;
};

type OverridableTrackBacking = SegmentableBacking & {
  [TRACK_METADATA_OVERRIDES]?: TrackMetadataOverrides;
  [ORIGINAL_GET_LANGUAGE_CODE]?: NonNullable<SegmentableBacking['getLanguageCode']>;
  [ORIGINAL_GET_NAME]?: NonNullable<SegmentableBacking['getName']>;
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
const resolvedHlsSegmentLocations = new WeakSet<object>();

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
  #source: Source;
  #visuallyImpaired: boolean | undefined;
  #name: string | null | undefined;
  #wholeResourceSegmentedInput: WholeResourceAudioSegmentedInput;

  constructor(params: {
    backing: SegmentableBacking;
    id: number;
    number: number;
    source: Source;
    visuallyImpaired?: boolean;
    name?: string | null;
  }) {
    this.#backing = params.backing;
    this.#id = params.id;
    this.#number = params.number;
    this.#source = params.source;
    this.#visuallyImpaired = params.visuallyImpaired;
    this.#name = params.name;
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
    return this.#name ?? this.#backing.getName?.() ?? null;
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
    const disposition = (this.#backing.getDisposition?.() ?? {}) as Record<string, boolean>;
    if (this.#visuallyImpaired === undefined) return disposition;
    return { ...disposition, visuallyImpaired: this.#visuallyImpaired };
  }

  getPairingMask() {
    return 0n;
  }

  getSource() {
    return this.#source;
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

    if (this.#backing.segmentedInput) {
      return this.#backing.segmentedInput;
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

  if ('segmentedInput' in backing && backing.segmentedInput) {
    return backing.segmentedInput;
  }

  const hlsBacking = backing as InputTrackWithBacking['_backing'];
  const internalTrack = hlsBacking.internalTrack;
  return internalTrack.demuxer.getSegmentedInputForPath(internalTrack.fullPath);
};

const isHlsSegment = (segment: HlsSegment | DashSegment): segment is HlsSegment =>
  !('sourcePath' in segment.location);

const resolveHlsSegmentLocation = async (source: Source, location: HlsSegment['location']) => {
  if (resolvedHlsSegmentLocations.has(location)) {
    return;
  }

  location.path = await resolvePathedSourcePath(source, {
    path: location.path,
    isRoot: false,
  });
  resolvedHlsSegmentLocations.add(location);
};

const resolveHlsSegments = async (source: Source, segments: (HlsSegment | DashSegment)[]) => {
  for (const segment of segments) {
    if (!isHlsSegment(segment)) {
      continue;
    }

    if (segment.initSegment) {
      await resolveHlsSegmentLocation(source, segment.initSegment.location);
    }
    await resolveHlsSegmentLocation(source, segment.location);
  }
};

const getTrackBacking = (
  track: MediabunnyInputTrack,
): InputTrackWithBacking['_backing'] | SegmentableBacking =>
  (track as InputTrackWithBacking)._backing as
    | InputTrackWithBacking['_backing']
    | SegmentableBacking;

const getTrackSource = (track: MediabunnyInputTrack) => {
  const backing = getTrackBacking(track) as SegmentableBacking;
  return backing.getSource?.() ?? track.input.source;
};

const getTrackMetadataOverrides = (backing: OverridableTrackBacking) =>
  (backing[TRACK_METADATA_OVERRIDES] ??= {});

const ensureTrackMetadataOverridePatch = (backing: SegmentableBacking) => {
  const patchedBacking = backing as OverridableTrackBacking;
  if (patchedBacking[ORIGINAL_GET_LANGUAGE_CODE]) {
    return patchedBacking;
  }

  const originalGetLanguageCode = backing.getLanguageCode?.bind(backing) ?? (() => 'und');
  patchedBacking[ORIGINAL_GET_LANGUAGE_CODE] = originalGetLanguageCode;
  patchedBacking[ORIGINAL_GET_NAME] = backing.getName?.bind(backing) ?? (() => null);
  Object.assign(backing, {
    getLanguageCode: () =>
      getTrackMetadataOverrides(patchedBacking).languageCode ??
      patchedBacking[ORIGINAL_GET_LANGUAGE_CODE]?.() ??
      'und',
    getName: () => {
      const { name } = getTrackMetadataOverrides(patchedBacking);
      return name !== undefined ? name : (patchedBacking[ORIGINAL_GET_NAME]?.() ?? null);
    },
  });
  return patchedBacking;
};

const setTrackLanguageCode = (track: MediabunnyInputTrack, value: string) => {
  getTrackMetadataOverrides(
    ensureTrackMetadataOverridePatch(getTrackBacking(track) as SegmentableBacking),
  ).languageCode = value;
};

const setTrackName = (track: MediabunnyInputTrack, value: string | null) => {
  getTrackMetadataOverrides(
    ensureTrackMetadataOverridePatch(getTrackBacking(track) as SegmentableBacking),
  ).name = value;
};

const getTrackOrigin = (track: MediabunnyInputTrack) =>
  (getTrackBacking(track) as { [ORIGIN_TRACK]?: InputTrack })[ORIGIN_TRACK];

const addSegmentAccess = <T extends MediabunnyInputTrack>(
  track: T,
): T &
  SegmentAccessMethods &
  TrackMetadataOverrideMethods &
  TrackSourceMethods &
  TrackOriginMethods =>
  new Proxy(track, {
    get(target, prop, receiver) {
      if (prop === 'source') {
        return getTrackSource(target);
      }

      if (prop === 'origin') {
        return getTrackOrigin(target) ?? receiver;
      }

      if (prop === 'getDynamicRange' && target instanceof MediabunnyInputVideoTrackClass) {
        return () => getDynamicRangeForTrack(target);
      }

      if (prop === 'setLanguageCode') {
        return (value: string) => setTrackLanguageCode(target, value);
      }

      if (prop === 'setName') {
        return (value: string | null) => setTrackName(target, value);
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
          await resolveHlsSegments(getTrackSource(target), segmentedInput.segments);
          return segmentedInput.segments;
        };
      }

      if (prop === 'refreshSegments') {
        return async () => {
          const segmentedInput = getSegmentedInputForTrack(target);
          await segmentedInput.runUpdateSegments();
          await resolveHlsSegments(getTrackSource(target), segmentedInput.segments);
          return segmentedInput.segments;
        };
      }

      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T &
    SegmentAccessMethods &
    TrackMetadataOverrideMethods &
    TrackSourceMethods &
    TrackOriginMethods;

/**
 * The backing of `origin` for a merged input: the same media under the merged input's ID, number and pairing
 * mask. Methods stay bound to the origin's backing, whose private state they read. Patches the merged
 * input applies (pairing, metadata overrides) land on this backing alone, and the origin's own patches, kept under
 * symbols, stay with the origin.
 */
const createMergedTrackBacking = (
  origin: InputTrack,
  merged: { id: number; number: number; pairingMask: bigint },
) => {
  const own: Record<PropertyKey, unknown> = {
    getId: () => merged.id,
    getNumber: () => merged.number,
    getPairingMask: () => merged.pairingMask,
    getSource: () => origin.source,
    [ORIGIN_TRACK]: origin.origin,
  };
  return new Proxy(getTrackBacking(origin) as TrackBacking, {
    get(target, prop) {
      if (Object.hasOwn(own, prop)) return own[prop];
      if (typeof prop === 'symbol') return undefined;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(_target, prop, value) {
      own[prop] = value;
      return true;
    },
    has(target, prop) {
      return Object.hasOwn(own, prop) || (typeof prop === 'string' && Reflect.has(target, prop));
    },
  });
};

/**
 * Pairing masks for the tracks of merged inputs. Tracks of one input keep that input's pairing, on bits no other
 * input uses. Tracks of different types in different inputs pair with each other, as merged inputs share a
 * timeline: each such pair gets a bit of its own, so no two tracks of one input gain a shared bit.
 */
const mergePairingMasks = (tracksByInput: readonly InputTrack[][]) => {
  const masks = new Map<InputTrack, bigint>();
  let nextBitIndex = 0n;
  const allocateBit = () => 1n << nextBitIndex++;

  for (const tracks of tracksByInput) {
    const bits = new Map<number, bigint>();
    for (const track of tracks) {
      let mask = 0n;
      const originalMask = (getTrackBacking(track) as SegmentableBacking).getPairingMask?.() ?? 0n;
      for (const index of getPairingMaskIndexes(originalMask)) {
        let bit = bits.get(index);
        if (bit === undefined) {
          bit = allocateBit();
          bits.set(index, bit);
        }
        mask |= bit;
      }
      masks.set(track, mask);
    }
  }

  const addBit = (track: InputTrack, bit: bigint) =>
    masks.set(track, (masks.get(track) ?? 0n) | bit);
  tracksByInput.forEach((first, firstIndex) => {
    for (const second of tracksByInput.slice(firstIndex + 1)) {
      for (const firstTrack of first) {
        for (const secondTrack of second) {
          if (firstTrack.type === secondTrack.type) continue;
          const bit = allocateBit();
          addBit(firstTrack, bit);
          addBit(secondTrack, bit);
        }
      }
    }
  });

  return masks;
};

/**
 * Backings for every track of `inputs`, in input order. IDs count up from 1 across all of them and numbers count
 * up per track type, so both stay unique within the merged input and repeat for the same inputs.
 */
const mergeTrackBackings = async (inputs: readonly SegmentedMediabunnyInput[]) => {
  const tracksByInput = await Promise.all(inputs.map((input) => input.getTracks()));
  const masks = mergePairingMasks(tracksByInput);
  const numbers = new Map<string, number>();
  return tracksByInput.flat().map((track, index) => {
    const number = (numbers.get(track.type) ?? 0) + 1;
    numbers.set(track.type, number);
    return createMergedTrackBacking(track, {
      id: index + 1,
      number,
      pairingMask: masks.get(track) ?? 0n,
    });
  });
};

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
  #removedTrackBackings = new Set<TrackBacking>();
  #audioInputs: MediabunnyInput[] = [];
  #nextCustomSubtitleTrackId = CUSTOM_SUBTITLE_TRACK_ID_OFFSET;
  #nextCustomSubtitleTrackNumber = CUSTOM_SUBTITLE_TRACK_ID_OFFSET;
  #nextCustomAudioTrackId = CUSTOM_AUDIO_TRACK_ID_OFFSET;
  #nextCustomAudioTrackNumber = CUSTOM_AUDIO_TRACK_ID_OFFSET;
  #nextPairingBitIndex: bigint | null = null;
  #mergedInputs: readonly SegmentedMediabunnyInput[] | null = null;
  #mergedBackingsPromise: Promise<TrackBacking[]> | null = null;

  /**
   * One input over the tracks of several, for media a service splits across manifests or files, such as one per
   * codec or quality. Inputs may mix manifests and direct files.
   *
   * Tracks of one input keep that input's pairing; tracks of different inputs pair with each other, as the inputs
   * are assumed to share a timeline. Track IDs count up from 1 in input order; `track.origin` is the track in its
   * own input. The merged input has no source or format of its own: read them per track.
   *
   * The merged input owns `inputs` and disposes them with itself. Do not use or change them after merging.
   */
  static merge<T extends SegmentedMediabunnyInput>(
    this: new (options: MediabunnyInputOptions) => T,
    inputs: readonly SegmentedMediabunnyInput[],
  ): T {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new TypeError('inputs must be a non-empty array.');
    }
    for (const input of inputs) {
      if (!(input instanceof SegmentedMediabunnyInput)) {
        throw new TypeError('inputs must be dasha inputs.');
      }
      if (input.disposed) {
        throw new TypeError('inputs must not be disposed.');
      }
    }
    if (new Set(inputs).size !== inputs.length) {
      throw new TypeError('inputs must not repeat an input.');
    }

    const merged = new this({ source: new BufferSource(new Uint8Array(0)), formats: [] });
    (merged as SegmentedMediabunnyInput).#mergedInputs = [...inputs];
    return merged;
  }

  override get source(): S {
    if (this.#mergedInputs) {
      throw new Error(MERGED_INPUT_HAS_NO_ROOT);
    }
    return super.source;
  }

  override _getDemuxer() {
    if (this.#mergedInputs) {
      return Promise.reject(new Error(MERGED_INPUT_HAS_NO_ROOT));
    }
    return super._getDemuxer();
  }

  override _getTrackBackings() {
    const inputs = this.#mergedInputs;
    if (!inputs) {
      return super._getTrackBackings();
    }

    if (!this.#mergedBackingsPromise) {
      const promise = mergeTrackBackings(inputs).then((backings) => {
        // Read when allocating pairing bits for tracks added to the merged input.
        (this as unknown as { _trackBackingsCache: TrackBacking[] })._trackBackingsCache = backings;
        return backings;
      });
      promise.catch(() => {
        if (this.#mergedBackingsPromise === promise) {
          this.#mergedBackingsPromise = null;
        }
      });
      this.#mergedBackingsPromise = promise;
    }
    return this.#mergedBackingsPromise;
  }

  async #queryTracks<T extends MediabunnyInputTrack>(
    query: InputTrackQuery<T> | undefined,
    type?: typeof BACKING_TYPE_VIDEO | typeof BACKING_TYPE_AUDIO | typeof BACKING_TYPE_SUBTITLE,
  ) {
    const internalInput = this as unknown as InternalInput<S>;
    const backings = await getTrackBackingsByType(internalInput, type);
    return queryWrappedTracks(
      internalInput,
      backings.filter((backing) => !this.#removedTrackBackings.has(backing)),
      query,
    );
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

    // Merged inputs already list the HLS subtitles of the inputs they merge.
    if (this.#mergedInputs || (await this.getFormat()) !== HLS) {
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
        visuallyImpaired: options.visuallyImpaired,
        name: options.name,
      });
      this.#pairAudioBacking(backing, pairWith);
      this.#customAudioBackings.push(backing);
      importedTracks.push(this._wrapBackingAsTrack(backing) as InputAudioTrack);
    }

    return importedTracks;
  }

  /** Removes an audio track from this input's track queries. */
  removeAudioTrack(track: InputAudioTrack): void {
    this.#removeTrack(track, BACKING_TYPE_AUDIO);
  }

  /** Removes a subtitle track from this input's track queries. */
  removeSubtitleTrack(track: InputSubtitleTrack): void {
    this.#removeTrack(track, BACKING_TYPE_SUBTITLE);
  }

  #removeTrack(
    track: MediabunnyInputTrack,
    expectedType: typeof BACKING_TYPE_AUDIO | typeof BACKING_TYPE_SUBTITLE,
  ) {
    if (track.input !== this) {
      throw new TypeError('track must belong to the same input instance.');
    }
    if (track.type !== expectedType) {
      throw new TypeError(`track must be an ${expectedType} track.`);
    }

    this.#removedTrackBackings.add(getTrackBacking(track) as TrackBacking);
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
    for (const input of [...this.#audioInputs, ...(this.#mergedInputs ?? [])]) {
      input.dispose();
    }
    this.#audioInputs.length = 0;
  }
}
