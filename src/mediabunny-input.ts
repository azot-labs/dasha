import { HLS, Input as MediabunnyInput, InputTrack as MediabunnyInputTrack } from 'mediabunny';
import type {
  InputAudioTrack as MediabunnyInputAudioTrack,
  EncodedPacket,
  MediaCodec,
  PacketType,
  InputVideoTrack as MediabunnyInputVideoTrack,
  Source,
} from 'mediabunny';
import type { HlsSegment, HlsSegmentedInput, InputTrackWithBacking } from './mediabunny';
import type { DashSegment, DashSegmentedInput } from './dash/dash-segmented-input';
import type { InputTrackQuery } from 'mediabunny';
import { getHlsSubtitleTrackBackings, HlsSubtitleTrackBacking } from './hls/hls-subtitles';

declare module 'mediabunny' {
  interface Input<S extends Source = Source> {
    _getTrackBackings(): Promise<unknown[]>;
    _wrapBackingAsTrack(backing: unknown): MediabunnyInputTrack;
  }
}

type SegmentAccessMethods = {
  getSegmentedInput(): HlsSegmentedInput | DashSegmentedInput;
  getSegments(): Promise<(HlsSegment | DashSegment)[]>;
};

export type MediabunnyTrackWithSegments = MediabunnyInputTrack & SegmentAccessMethods;
export type MediabunnyVideoTrackWithSegments = MediabunnyInputVideoTrack & SegmentAccessMethods;
export type MediabunnyAudioTrackWithSegments = MediabunnyInputAudioTrack & SegmentAccessMethods;

type NativeTrackBacking = Parameters<MediabunnyInput<Source>['_wrapBackingAsTrack']>[0];
type InternalInput<S extends Source = Source> = MediabunnyInput<S> & {
  _getTrackBackings(): Promise<NativeTrackBacking[]>;
  _getSyntheticTrackBackings?(
    type?: typeof BACKING_TYPE_VIDEO | typeof BACKING_TYPE_AUDIO | typeof BACKING_TYPE_SUBTITLE,
  ): Promise<TrackBacking[]>;
};

type SegmentableBacking = {
  getId(): number;
  getNumber(): number;
  getType(): string;
  getCodec(): MediaCodec | null | Promise<MediaCodec | null>;
  getInternalCodecId?(): string | number | Uint8Array | null | Promise<string | number | Uint8Array | null>;
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
type TrackBacking = NativeTrackBacking | SegmentableBacking;

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
  const nativeBackings = await input._getTrackBackings();
  const syntheticBackings = (await input._getSyntheticTrackBackings?.(type)) ?? [];
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

  prototype[BASE_INPUT_PATCHED] = true;
};

const getSegmentedInputForTrack = (
  track: MediabunnyInputTrack,
): HlsSegmentedInput | DashSegmentedInput => {
  const backing = (track as InputTrackWithBacking)._backing as
    | InputTrackWithBacking['_backing']
    | SegmentableBacking;
  if ('getSegmentedInput' in backing && typeof backing.getSegmentedInput === 'function') {
    return backing.getSegmentedInput();
  }

  const hlsBacking = backing as InputTrackWithBacking['_backing'];
  const internalTrack = hlsBacking.internalTrack;
  return internalTrack.demuxer.getSegmentedInputForPath(internalTrack.fullPath);
};

const addSegmentAccess = <T extends MediabunnyInputTrack>(track: T): T & SegmentAccessMethods =>
  new Proxy(track, {
    get(target, prop) {
      if (prop === 'getSegmentedInput') {
        return () => getSegmentedInputForTrack(target);
      }

      if (prop === 'getSegments') {
        return async () => {
          const segmentedInput = getSegmentedInputForTrack(target);
          await segmentedInput.runUpdateSegments();
          return segmentedInput.segments;
        };
      }

      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T & SegmentAccessMethods;

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
  #trackCache = new WeakMap<MediabunnyInputTrack, MediabunnyTrackWithSegments>();
  #subtitleTrackCache = new WeakMap<object, MediabunnyInputSubtitleTrack>();
  #hlsSubtitleBackingsPromise: Promise<HlsSubtitleTrackBacking[]> | null = null;

  async #queryTracks<T extends MediabunnyInputTrack>(
    query: InputTrackQuery<T> | undefined,
    type?: typeof BACKING_TYPE_VIDEO | typeof BACKING_TYPE_AUDIO | typeof BACKING_TYPE_SUBTITLE,
  ) {
    const backings = await getTrackBackingsByType(this as InternalInput<S>, type);
    return queryWrappedTracks(this as InternalInput<S>, backings, query);
  }

  override _wrapBackingAsTrack(backing: TrackBacking): MediabunnyTrackWithSegments {
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
    if (type && type !== BACKING_TYPE_SUBTITLE) {
      return [];
    }

    if ((await this.getFormat()) !== HLS) {
      return [];
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

    return this.#hlsSubtitleBackingsPromise;
  }

  #wrapSubtitleBacking(backing: SegmentableBacking) {
    const existing = this.#subtitleTrackCache.get(backing);
    if (existing) return existing;

    const track = new MediabunnyInputSubtitleTrack(this, backing);
    this.#subtitleTrackCache.set(backing, track);
    return track;
  }

  override async getTracks(query?: InputTrackQuery<MediabunnyTrackWithSegments>) {
    return (await this.#queryTracks(query)) as MediabunnyTrackWithSegments[];
  }

  override async getVideoTracks(query?: InputTrackQuery<MediabunnyVideoTrackWithSegments>) {
    return (await this.#queryTracks(
      query,
      BACKING_TYPE_VIDEO,
    )) as MediabunnyVideoTrackWithSegments[];
  }

  override async getAudioTracks(query?: InputTrackQuery<MediabunnyAudioTrackWithSegments>) {
    return (await this.#queryTracks(
      query,
      BACKING_TYPE_AUDIO,
    )) as MediabunnyAudioTrackWithSegments[];
  }

  override async getPrimaryVideoTrack(query?: InputTrackQuery<MediabunnyVideoTrackWithSegments>) {
    return (await super.getPrimaryVideoTrack(
      query as never,
    )) as MediabunnyVideoTrackWithSegments | null;
  }

  override async getPrimaryAudioTrack(query?: InputTrackQuery<MediabunnyAudioTrackWithSegments>) {
    return (await super.getPrimaryAudioTrack(
      query as never,
    )) as MediabunnyAudioTrackWithSegments | null;
  }
}
