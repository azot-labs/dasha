import {
  FilePathSource,
  Input as MediabunnyInput,
  UrlSource,
  HLS_FORMATS,
  desc,
  asc,
  prefer,
  SourceRef,
} from 'mediabunny';
import type {
  Input as MediabunnyInputInstance,
  InputAudioTrack as MediabunnyInputAudioTrack,
  InputFormat as MediabunnyInputFormat,
  InputOptions as MediabunnyInputOptions,
  InputTrack as MediabunnyInputTrack,
  InputVideoTrack as MediabunnyInputVideoTrack,
  Source,
} from 'mediabunny';
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

type BackendInput<S extends Source = Source> = DashInput | MediabunnyInputInstance<S>;

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

const createBackendInput = <S extends Source = Source>(
  options: DashaInputOptions<S>,
): BackendInput<S> => {
  if (shouldUseDashBackend(options)) {
    const source = options.source instanceof SourceRef ? options.source.source : options.source;
    return new DashInput(source) as BackendInput<S>;
  }

  const formats = options.formats.filter((format) => !isDashFormat(format));
  return new MediabunnyInput({
    ...options,
    formats,
  } as MediabunnyInputOptions<Source>) as BackendInput<S>;
};

export class Input<S extends Source = Source> {
  readonly source: Source;

  #backend: BackendInput<S>;

  constructor(options: DashaInputOptions<S>) {
    this.#backend = createBackendInput(options);
    this.source = this.#backend.source;
  }

  async getFormat() {
    return this.#backend.getFormat();
  }

  async canRead() {
    return this.#backend.canRead();
  }

  async getDurationFromMetadata(tracks?: InputTrack[]) {
    if (!('getDurationFromMetadata' in this.#backend)) {
      return null;
    }

    return this.#backend.getDurationFromMetadata?.(tracks as never);
  }

  async getTracks(query?: InputTrackQuery<InputTrack>) {
    return this.#backend.getTracks(query as never) as Promise<InputTrack[]>;
  }

  async getVideoTracks(query?: InputTrackQuery<InputVideoTrack>) {
    return this.#backend.getVideoTracks(query as never) as Promise<InputVideoTrack[]>;
  }

  async getAudioTracks(query?: InputTrackQuery<InputAudioTrack>) {
    return this.#backend.getAudioTracks(query as never) as Promise<InputAudioTrack[]>;
  }

  async getPrimaryVideoTrack(query?: InputTrackQuery<InputVideoTrack>) {
    return this.#backend.getPrimaryVideoTrack(query as never) as Promise<InputVideoTrack | null>;
  }

  async getPrimaryAudioTrack(query?: InputTrackQuery<InputAudioTrack>) {
    return this.#backend.getPrimaryAudioTrack(query as never) as Promise<InputAudioTrack | null>;
  }

  dispose() {
    this.#backend.dispose();
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

export const isInput = (value: unknown): value is Input => value instanceof Input;

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

export { FilePathSource, UrlSource, HLS_FORMATS, DASH, DASH_FORMATS, desc, asc, prefer };
export type {
  HlsSegment,
  HlsSegmentedInput,
  DashSegment,
  DashSegmentedInput,
  InputTrackWithBacking,
  InputTrackQuery,
};
