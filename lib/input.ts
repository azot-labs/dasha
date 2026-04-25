import {
  FilePathSource,
  UrlSource,
  HLS_FORMATS,
  desc,
  asc,
  prefer,
  SourceRef,
} from 'mediabunny';
import type {
  InputFormat as MediabunnyInputFormat,
  InputOptions as MediabunnyInputOptions,
  Source,
} from 'mediabunny';
import type { HlsSegmentedInput, HlsSegment, InputTrackWithBacking } from './mediabunny';
import {
  DASH,
  DASH_FORMATS,
  DashInput,
  DashInputFormat,
  DashInputTrack,
  DashInputVideoTrack,
  DashInputAudioTrack,
  DashSegment,
  DashSegmentedInput,
  InputTrackQuery,
} from './dash-input';
import {
  SegmentedMediabunnyInput,
  type MediabunnyAudioTrackWithSegments,
  type MediabunnyTrackWithSegments,
  type MediabunnyVideoTrackWithSegments,
} from './mediabunny-input';

type DashaInputOptions<S extends Source = Source> = Omit<MediabunnyInputOptions<S>, 'formats'> & {
  formats: readonly (MediabunnyInputFormat | DashInputFormat)[];
};

export type InputSegment = HlsSegment | DashSegment;
export type InputSegmentedInput = HlsSegmentedInput | DashSegmentedInput;
export type InputTrack = MediabunnyTrackWithSegments | DashInputTrack;
export type InputVideoTrack = MediabunnyVideoTrackWithSegments | DashInputVideoTrack;
export type InputAudioTrack = MediabunnyAudioTrackWithSegments | DashInputAudioTrack;

type InputBackend<S extends Source = Source> = {
  readonly source: S | Source;
  getFormat(): Promise<MediabunnyInputFormat | DashInputFormat>;
  canRead(): Promise<boolean>;
  getDurationFromMetadata(tracks?: InputTrack[]): Promise<number | null>;
  getTracks(query?: InputTrackQuery<InputTrack>): Promise<InputTrack[]>;
  getVideoTracks(query?: InputTrackQuery<InputVideoTrack>): Promise<InputVideoTrack[]>;
  getAudioTracks(query?: InputTrackQuery<InputAudioTrack>): Promise<InputAudioTrack[]>;
  getPrimaryVideoTrack(query?: InputTrackQuery<InputVideoTrack>): Promise<InputVideoTrack | null>;
  getPrimaryAudioTrack(query?: InputTrackQuery<InputAudioTrack>): Promise<InputAudioTrack | null>;
  dispose(): void;
};

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
): InputBackend<S> => {
  if (shouldUseDashBackend(options)) {
    const source = options.source instanceof SourceRef ? options.source.source : options.source;
    return new DashInput(source) as InputBackend<S>;
  }

  const formats = options.formats.filter((format) => !isDashFormat(format));
  return new SegmentedMediabunnyInput({
    ...options,
    formats,
  } as MediabunnyInputOptions<Source>) as InputBackend<S>;
};

export class Input<S extends Source = Source> {
  readonly source: Source;

  #backend: InputBackend<S>;

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
    return this.#backend.getDurationFromMetadata(tracks);
  }

  async getTracks(query?: InputTrackQuery<InputTrack>) {
    return this.#backend.getTracks(query);
  }

  async getVideoTracks(query?: InputTrackQuery<InputVideoTrack>) {
    return this.#backend.getVideoTracks(query);
  }

  async getAudioTracks(query?: InputTrackQuery<InputAudioTrack>) {
    return this.#backend.getAudioTracks(query);
  }

  async getPrimaryVideoTrack(query?: InputTrackQuery<InputVideoTrack>) {
    return this.#backend.getPrimaryVideoTrack(query);
  }

  async getPrimaryAudioTrack(query?: InputTrackQuery<InputAudioTrack>) {
    return this.#backend.getPrimaryAudioTrack(query);
  }

  dispose() {
    this.#backend.dispose();
  }

  [Symbol.dispose]() {
    this.dispose();
  }
}

export const isInput = (value: unknown): value is Input => value instanceof Input;

export const getSegmentedInput = (track: InputTrack): InputSegmentedInput => track.getSegmentedInput();

export const getSegments = async (track: InputTrack): Promise<InputSegment[]> => track.getSegments();

export { FilePathSource, UrlSource, HLS_FORMATS, DASH, DASH_FORMATS, desc, asc, prefer };
export type {
  HlsSegment,
  HlsSegmentedInput,
  DashSegment,
  DashSegmentedInput,
  InputTrackWithBacking,
  InputTrackQuery,
};
