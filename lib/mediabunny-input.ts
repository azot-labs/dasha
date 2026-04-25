import { Input as MediabunnyInput, InputTrack as MediabunnyInputTrack } from 'mediabunny';
import type {
  InputAudioTrack as MediabunnyInputAudioTrack,
  EncodedPacket,
  MediaCodec,
  PacketType,
  InputVideoTrack as MediabunnyInputVideoTrack,
  Source,
} from 'mediabunny';
import type { HlsSegment, HlsSegmentedInput, InputTrackWithBacking } from './mediabunny';
import type { DashSegment, DashSegmentedInput } from './dash';
import type { InputTrackQuery } from 'mediabunny';

declare module 'mediabunny' {
  interface Input<S extends Source = Source> {
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

type TrackBacking = Parameters<MediabunnyInput<Source>['_wrapBackingAsTrack']>[0];

type SegmentableBacking = {
  getType(): string;
  getCodec(): MediaCodec | null | Promise<MediaCodec | null>;
  getMetadataCodecParameterString?(): string | null | Promise<string | null>;
  getSegmentedInput?(): HlsSegmentedInput | DashSegmentedInput;
};

const requireSync = <T>(value: T | Promise<T>, getterName: string, asyncName: string): T => {
  if (value instanceof Promise) {
    throw new Error(
      `'${getterName}' is not available synchronously for this track. Use '${asyncName}()' instead.`,
    );
  }
  return value;
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

export class SegmentedMediabunnyInput<S extends Source = Source> extends MediabunnyInput<S> {
  #trackCache = new WeakMap<MediabunnyInputTrack, MediabunnyTrackWithSegments>();
  #subtitleTrackCache = new WeakMap<object, MediabunnyInputSubtitleTrack>();

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

  #wrapSubtitleBacking(backing: SegmentableBacking) {
    const existing = this.#subtitleTrackCache.get(backing);
    if (existing) return existing;

    const track = new MediabunnyInputSubtitleTrack(this, backing);
    this.#subtitleTrackCache.set(backing, track);
    return track;
  }

  override async getTracks(query?: InputTrackQuery<MediabunnyTrackWithSegments>) {
    return (await super.getTracks(query as never)) as MediabunnyTrackWithSegments[];
  }

  override async getVideoTracks(query?: InputTrackQuery<MediabunnyVideoTrackWithSegments>) {
    return (await super.getVideoTracks(query as never)) as MediabunnyVideoTrackWithSegments[];
  }

  override async getAudioTracks(query?: InputTrackQuery<MediabunnyAudioTrackWithSegments>) {
    return (await super.getAudioTracks(query as never)) as MediabunnyAudioTrackWithSegments[];
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
