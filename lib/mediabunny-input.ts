import { Input as MediabunnyInput } from 'mediabunny';
import type {
  InputAudioTrack as MediabunnyInputAudioTrack,
  InputTrack as MediabunnyInputTrack,
  InputVideoTrack as MediabunnyInputVideoTrack,
  Source,
} from 'mediabunny';
import type { InputTrackQuery } from './dash-input';
import type { HlsSegment, HlsSegmentedInput, InputTrackWithBacking } from './mediabunny';

declare module 'mediabunny' {
  interface Input<S extends Source = Source> {
    _wrapBackingAsTrack(backing: unknown): MediabunnyInputTrack;
  }
}

type SegmentAccessMethods = {
  getSegmentedInput(): HlsSegmentedInput;
  getSegments(): Promise<HlsSegment[]>;
};

export type MediabunnyTrackWithSegments = MediabunnyInputTrack & SegmentAccessMethods;
export type MediabunnyVideoTrackWithSegments = MediabunnyInputVideoTrack & SegmentAccessMethods;
export type MediabunnyAudioTrackWithSegments = MediabunnyInputAudioTrack & SegmentAccessMethods;

type TrackBacking = Parameters<MediabunnyInput<Source>['_wrapBackingAsTrack']>[0];

const getSegmentedInputForTrack = (track: MediabunnyInputTrack): HlsSegmentedInput => {
  const backing = (track as InputTrackWithBacking)._backing;
  const internalTrack = backing.internalTrack;
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

export class SegmentedMediabunnyInput<S extends Source = Source> extends MediabunnyInput<S> {
  #trackCache = new WeakMap<MediabunnyInputTrack, MediabunnyTrackWithSegments>();

  override _wrapBackingAsTrack(backing: TrackBacking): MediabunnyTrackWithSegments {
    const track = super._wrapBackingAsTrack(backing);
    const existing = this.#trackCache.get(track);
    if (existing) return existing;

    const wrapped = addSegmentAccess(track);
    this.#trackCache.set(track, wrapped);
    return wrapped;
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
    return (await super.getPrimaryVideoTrack(query as never)) as MediabunnyVideoTrackWithSegments | null;
  }

  override async getPrimaryAudioTrack(query?: InputTrackQuery<MediabunnyAudioTrackWithSegments>) {
    return (await super.getPrimaryAudioTrack(query as never)) as MediabunnyAudioTrackWithSegments | null;
  }
}
