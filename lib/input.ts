import {
  Input as MediabunnyInput,
  UrlSource,
  HLS_FORMATS,
  desc,
  asc,
  prefer,
  InputTrack as MediabunnyInputTrack,
  InputVideoTrack as MediabunnyInputVideoTrack,
  InputAudioTrack as MediabunnyInputAudioTrack,
  SourceRef,
} from 'mediabunny';
import type { InputOptions as MediabunnyInputOptions, InputFormat as MediabunnyInputFormat, Source } from 'mediabunny';
import type { HlsSegmentedInput, HlsSegment, InputTrackWithBacking } from './mediabunny';
import {
  DASH,
  DASH_FORMATS,
  DashInput,
  DashInputAudioTrack,
  DashInputFormat,
  DashInputTrack,
  DashInputVideoTrack,
  DashSegment,
  DashSegmentedInput,
  InputTrackQuery,
  isDashInputTrack,
} from './dash-input';

type DashaInputOptions<S extends Source = Source> = Omit<MediabunnyInputOptions<S>, 'formats'> & {
  formats: readonly (MediabunnyInputFormat | DashInputFormat)[];
};

export type InputTrack =
  | MediabunnyInputTrack
  | DashInputTrack;

export type InputVideoTrack =
  | MediabunnyInputVideoTrack
  | DashInputVideoTrack;

export type InputAudioTrack =
  | MediabunnyInputAudioTrack
  | DashInputAudioTrack;

export type InputSegment = HlsSegment | DashSegment;
export type InputSegmentedInput = HlsSegmentedInput | DashSegmentedInput;

export type Input = {
  readonly source: Source;
  getFormat(): Promise<MediabunnyInputFormat | DashInputFormat>;
  canRead(): Promise<boolean>;
  getTracks(query?: InputTrackQuery<InputTrack>): Promise<InputTrack[]>;
  getVideoTracks(query?: InputTrackQuery<InputVideoTrack>): Promise<InputVideoTrack[]>;
  getAudioTracks(query?: InputTrackQuery<InputAudioTrack>): Promise<InputAudioTrack[]>;
  getPrimaryVideoTrack(query?: InputTrackQuery<InputVideoTrack>): Promise<InputVideoTrack | null>;
  getPrimaryAudioTrack(query?: InputTrackQuery<InputAudioTrack>): Promise<InputAudioTrack | null>;
  dispose(): void;
};

type InputConstructor = new <S extends Source = Source>(options: DashaInputOptions<S>) => Input;

const isDashFormat = (format: MediabunnyInputFormat | DashInputFormat): format is DashInputFormat =>
  format instanceof DashInputFormat;

const shouldUseDashBackend = (options: DashaInputOptions) => {
  const hasDash = options.formats.some(isDashFormat);
  if (!hasDash) return false;

  const hasNonDash = options.formats.some((format) => !isDashFormat(format));
  if (!hasNonDash) return true;

  const source = options.source instanceof SourceRef ? options.source.source : options.source;
  if ('rootPath' in source && typeof source.rootPath === 'string') {
    const path = source.rootPath.toLowerCase();
    if (path.includes('.mpd')) return true;
    if (path.includes('.m3u8') || path.includes('.m3u')) return false;
  }

  return true;
};

const createInput = (options: DashaInputOptions): Input => {
  if (shouldUseDashBackend(options)) {
    const source = options.source instanceof SourceRef ? options.source.source : options.source;
    return new DashInput(source);
  }

  const formats = options.formats.filter((format) => !isDashFormat(format));
  return new MediabunnyInput({
    ...options,
    formats,
  } as MediabunnyInputOptions<Source>) as unknown as Input;
};

export const isInput = (value: unknown): value is Input =>
  value instanceof DashInput || value instanceof MediabunnyInput;

export const getSegmentedInput = (track: InputTrack): InputSegmentedInput => {
  if (isDashInputTrack(track)) {
    return track.getSegmentedInput();
  }

  const backing = (track as InputTrackWithBacking)._backing;
  const internalTrack = backing.internalTrack;
  return internalTrack.demuxer.getSegmentedInputForPath(internalTrack.fullPath);
};

export const getSegments = async (track: InputTrack): Promise<InputSegment[]> => {
  if (isDashInputTrack(track)) {
    const segmentedInput = track.getSegmentedInput();
    await segmentedInput.runUpdateSegments();
    return segmentedInput.segments;
  }

  const segmentedInput = getSegmentedInput(track) as HlsSegmentedInput;
  await segmentedInput.runUpdateSegments();
  return segmentedInput.segments;
};

export const Input: InputConstructor = class InputFacade {
  constructor(options: DashaInputOptions) {
    return createInput(options);
  }
} as InputConstructor;

export const InputTrack = MediabunnyInputTrack;
export const InputVideoTrack = MediabunnyInputVideoTrack;
export const InputAudioTrack = MediabunnyInputAudioTrack;

export { UrlSource, HLS_FORMATS, DASH, DASH_FORMATS, desc, asc, prefer };
export type {
  HlsSegment,
  HlsSegmentedInput,
  DashSegment,
  DashSegmentedInput,
  InputTrackWithBacking,
  InputTrackQuery,
};
