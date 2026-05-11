import { FilePathSource, UrlSource, HLS_FORMATS, desc, asc, prefer } from 'mediabunny';
import type { InputFormat, InputOptions as MediabunnyInputOptions, Source } from 'mediabunny';
import type { HlsSegmentedInput, HlsSegment, InputTrackWithBacking } from './mediabunny';
import { DASH, DASH_FORMATS } from './dash/dash-demuxer';
import type { DashSegment, DashSegmentedInput } from './dash/dash-segmented-input';
import {
  SegmentedMediabunnyInput,
  type MediabunnyAudioTrackWithSegments,
  type MediabunnySubtitleTrackWithSegments,
  type MediabunnyTrackWithSegments,
  type MediabunnyVideoTrackWithSegments,
  type InputSubtitleSource,
  type InputSubtitleTrackMetadata,
  preserveSubtitleBackingsOnInput,
} from './mediabunny-input';

type DashaInputOptions<S extends Source = Source> = Omit<MediabunnyInputOptions<S>, 'formats'> & {
  formats: readonly InputFormat[];
};

export type InputSegment = HlsSegment | DashSegment;
export type InputSegmentedInput = HlsSegmentedInput | DashSegmentedInput;
export type InputTrack = MediabunnyTrackWithSegments;
export type InputVideoTrack = MediabunnyVideoTrackWithSegments;
export type InputAudioTrack = MediabunnyAudioTrackWithSegments;
export type InputSubtitleTrack = MediabunnySubtitleTrackWithSegments;

export class Input<S extends Source = Source> extends SegmentedMediabunnyInput<S> {
  constructor(options: DashaInputOptions<S>) {
    super(options as MediabunnyInputOptions<S>);
  }
}

export const isInput = (value: unknown): value is Input => value instanceof Input;

export const getSegmentedInput = (track: InputTrack): InputSegmentedInput =>
  track.getSegmentedInput();

export const getSegments = async (track: InputTrack): Promise<InputSegment[]> =>
  track.getSegments();

export { FilePathSource, UrlSource, HLS_FORMATS, DASH, DASH_FORMATS, desc, asc, prefer };
export { preserveSubtitleBackingsOnInput };
export type { MediaCodec, SubtitleCodec } from './codec';
export type { InputSubtitleSource, InputSubtitleTrackMetadata };
export type {
  HlsSegment,
  HlsSegmentedInput,
  DashSegment,
  DashSegmentedInput,
  InputTrackWithBacking,
};
export type { InputTrackQuery } from 'mediabunny';
