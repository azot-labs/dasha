import { FilePathSource, UrlSource, HLS_FORMATS, desc, asc, prefer } from 'mediabunny';
import type { InputFormat, InputOptions as MediabunnyInputOptions, Source } from 'mediabunny';
import type { HlsSegmentedInput, HlsSegment, InputTrackWithBacking } from './mediabunny';
import { DASH, DASH_FORMATS } from './dash';
import type { DashSegment, DashSegmentedInput } from './dash';
import {
  SegmentedMediabunnyInput,
  type MediabunnyAudioTrackWithSegments,
  type MediabunnyTrackWithSegments,
  type MediabunnyVideoTrackWithSegments,
} from './mediabunny-input';

type DashaInputOptions<S extends Source = Source> = Omit<MediabunnyInputOptions<S>, 'formats'> & {
  formats: readonly InputFormat[];
};

export type InputSegment = HlsSegment | DashSegment;
export type InputSegmentedInput = HlsSegmentedInput | DashSegmentedInput;
export type InputTrack = MediabunnyTrackWithSegments;
export type InputVideoTrack = MediabunnyVideoTrackWithSegments;
export type InputAudioTrack = MediabunnyAudioTrackWithSegments;

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
export type {
  HlsSegment,
  HlsSegmentedInput,
  DashSegment,
  DashSegmentedInput,
  InputTrackWithBacking,
};
export type { InputTrackQuery } from 'mediabunny';
