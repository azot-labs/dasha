import { readFile } from 'node:fs/promises';
import { desc, prefer } from 'mediabunny';
import type { Source } from 'mediabunny';
import { ParserConfig } from './parser-config';
import { DashExtractor } from './dash/dash-extractor';
import type { EncryptInfo } from './shared/encrypt-info';
import { ENCRYPT_METHODS } from './shared/encrypt-method';
import type { MediaSegment } from './shared/media-segment';
import type { Playlist } from './shared/playlist';
import { ROLE_TYPE } from './shared/role-type';
import type {
  AudioStreamInfo,
  MediaStreamInfo,
  SubtitleStreamInfo,
  VideoStreamInfo,
} from './shared/stream-info';

// TODO: Remove this once mediabunny will ship DASH support ^^

type MaybePromise<T> = T | Promise<T>;

export type TrackDisposition = {
  default: boolean;
  primary: boolean;
  forced: boolean;
  original: boolean;
  commentary: boolean;
  hearingImpaired: boolean;
  visuallyImpaired: boolean;
};

export type InputTrackQuery<T> = {
  filter?: (track: T) => MaybePromise<boolean>;
  sortBy?: (track: T) => MaybePromise<number | number[]>;
};

export type Segment = {
  timestamp: number;
  duration: number;
  relativeToUnixEpoch: boolean;
  firstSegment: DashSegment | null;
};

export type DashSegmentLocation = {
  path: string;
  offset: number;
  length: number | null;
};

export type DashEncryptionInfo = {
  method: string;
  key: Uint8Array | undefined;
  iv: Uint8Array | undefined;
  drm: EncryptInfo['drm'];
};

export type DashSegment = Segment & {
  sequenceNumber: number | null;
  location: DashSegmentLocation;
  encryption: DashEncryptionInfo | null;
  firstSegment: DashSegment | null;
  initSegment: DashSegment | null;
  lastProgramDateTimeSeconds: number | null;
};

export class DashSegmentedInput {
  segments: DashSegment[] = [];

  #track: DashInputTrack;

  constructor(track: DashInputTrack) {
    this.#track = track;
  }

  async runUpdateSegments(): Promise<void> {
    await this.#track.input.refreshSegments(this.#track);
    this.segments = this.#track.toSegments();
  }
}

const DEFAULT_DISPOSITION: TrackDisposition = {
  default: true,
  primary: true,
  forced: false,
  original: false,
  commentary: false,
  hearingImpaired: false,
  visuallyImpaired: false,
};

const toQuerySortArray = (value: number | number[]) => (Array.isArray(value) ? value : [value]);

const compareNumbers = (a: number[], b: number[]) => {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
};

const queryTracks = async <T>(tracks: T[], query?: InputTrackQuery<T>) => {
  if (!query) return [...tracks];

  const filtered: T[] = [];
  for (const track of tracks) {
    const allowed = (await query.filter?.(track)) ?? true;
    if (allowed) filtered.push(track);
  }

  if (!query.sortBy) return filtered;

  const sortValues = await Promise.all(
    filtered.map(async (track, index) => ({
      index,
      track,
      order: toQuerySortArray(await query.sortBy!(track)),
    })),
  );

  sortValues.sort(
    (left, right) => compareNumbers(left.order, right.order) || left.index - right.index,
  );
  return sortValues.map((item) => item.track);
};

const normalizeHeaders = (headers: HeadersInit | undefined): Record<string, string> => {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
};

const getSourcePath = (source: Source): string | undefined => {
  if ('rootPath' in source && typeof source.rootPath === 'string') {
    return source.rootPath;
  }
};

const getSourceHeaders = (source: Source): Record<string, string> => {
  const requestHeaders =
    '_url' in source && source._url instanceof Request ? normalizeHeaders(source._url.headers) : {};
  const options =
    '_options' in source && source._options && typeof source._options === 'object'
      ? (source._options as { requestInit?: RequestInit })
      : undefined;
  const optionHeaders = normalizeHeaders(options?.requestInit?.headers);
  return {
    ...requestHeaders,
    ...optionHeaders,
  };
};

const parseOriginalUrlFromManifest = (text: string) =>
  text.match(/<!--\s*URL:\s*([^\n]+?)\s*-->/)?.[1]?.trim();

const loadManifestText = async (source: Source) => {
  const manifestPath = getSourcePath(source);
  if (!manifestPath) {
    throw new Error('DASH input currently requires a pathed source such as UrlSource.');
  }

  if (manifestPath.startsWith('http://') || manifestPath.startsWith('https://')) {
    const response = await fetch(manifestPath, {
      headers: getSourceHeaders(source),
    });
    const text = await response.text();
    return {
      text,
      url: response.url,
    };
  }

  if (manifestPath.startsWith('file:')) {
    const filePath = new URL(manifestPath);
    const text = await readFile(filePath, 'utf8');
    return {
      text,
      url: parseOriginalUrlFromManifest(text) ?? manifestPath,
    };
  }

  const text = await readFile(manifestPath, 'utf8');
  return {
    text,
    url: parseOriginalUrlFromManifest(text) ?? manifestPath,
  };
};

const getSegmentLocation = (segment: MediaSegment): DashSegmentLocation => ({
  path: segment.url,
  offset: segment.startRange ?? 0,
  length: segment.expectLength ?? null,
});

const getSegmentEncryption = (encryptInfo: EncryptInfo): DashEncryptionInfo | null => {
  if (
    encryptInfo.method === ENCRYPT_METHODS.NONE ||
    encryptInfo.method === ENCRYPT_METHODS.UNKNOWN
  ) {
    return null;
  }

  return {
    method: encryptInfo.method,
    key: encryptInfo.key,
    iv: encryptInfo.iv,
    drm: encryptInfo.drm,
  };
};

const createInitSegment = (
  segment: MediaSegment,
  firstSegment: DashSegment | null,
): DashSegment => ({
  timestamp: 0,
  duration: 0,
  relativeToUnixEpoch: false,
  firstSegment,
  sequenceNumber: Number.isFinite(segment.index) ? segment.index : null,
  location: getSegmentLocation(segment),
  encryption: getSegmentEncryption(segment.encryptInfo),
  initSegment: null,
  lastProgramDateTimeSeconds: null,
});

const flattenSegments = (playlist?: Playlist) =>
  playlist?.mediaParts.flatMap((part) => part.mediaSegments) ?? [];

const playlistToSegments = (playlist?: Playlist): DashSegment[] => {
  const mediaSegments = flattenSegments(playlist);
  if (mediaSegments.length === 0) return [];

  let timestamp = 0;
  const segments: DashSegment[] = [];

  for (const mediaSegment of mediaSegments) {
    const dashSegment: DashSegment = {
      timestamp,
      duration: mediaSegment.duration,
      relativeToUnixEpoch: false,
      firstSegment: null,
      sequenceNumber: Number.isFinite(mediaSegment.index) ? mediaSegment.index : null,
      location: getSegmentLocation(mediaSegment),
      encryption: getSegmentEncryption(mediaSegment.encryptInfo),
      initSegment: null,
      lastProgramDateTimeSeconds: null,
    };
    segments.push(dashSegment);
    timestamp += mediaSegment.duration;
  }

  const firstSegment = segments[0] ?? null;
  const initSegment = playlist?.mediaInit
    ? createInitSegment(playlist.mediaInit, firstSegment)
    : null;

  for (const segment of segments) {
    segment.firstSegment = firstSegment;
    segment.initSegment = initSegment;
  }

  return segments;
};

abstract class DashInputTrackBase {
  readonly input: DashInput;
  readonly streamInfo: MediaStreamInfo;

  readonly id: number;
  readonly number: number;

  #segmentedInput?: DashSegmentedInput;

  constructor(input: DashInput, streamInfo: MediaStreamInfo, id: number, number: number) {
    this.input = input;
    this.streamInfo = streamInfo;
    this.id = id;
    this.number = number;
  }

  async getCodec() {
    return this.streamInfo.codec ?? null;
  }

  get codec() {
    return this.streamInfo.codec ?? null;
  }

  async getCodecParameterString() {
    return this.streamInfo.codecs;
  }

  async getLanguageCode() {
    return this.streamInfo.languageCode ?? 'und';
  }

  async getName() {
    return this.streamInfo.name ?? null;
  }

  get name() {
    return this.streamInfo.name ?? null;
  }

  async getBitrate() {
    return this.streamInfo.bitrate ?? null;
  }

  async getAverageBitrate() {
    return this.streamInfo.bitrate ?? null;
  }

  async getDurationFromMetadata() {
    return this.streamInfo.playlist?.totalDuration ?? null;
  }

  async computeDuration() {
    return this.streamInfo.playlist?.totalDuration ?? 0;
  }

  async getFirstTimestamp() {
    return 0;
  }

  async hasOnlyKeyPackets() {
    return false;
  }

  async canDecode() {
    return true;
  }

  async isLive() {
    return this.streamInfo.playlist?.isLive ?? false;
  }

  async getLiveRefreshInterval() {
    if (!this.streamInfo.playlist?.isLive) return null;
    return this.streamInfo.playlist.refreshIntervalMs / 1000;
  }

  async getDisposition(): Promise<TrackDisposition> {
    const subtitleStreamInfo =
      this.streamInfo.type === 'subtitle' ? (this.streamInfo as SubtitleStreamInfo) : undefined;
    const audioStreamInfo =
      this.streamInfo.type === 'audio' ? (this.streamInfo as AudioStreamInfo) : undefined;

    return {
      ...DEFAULT_DISPOSITION,
      default: !!this.streamInfo.default,
      commentary: this.streamInfo.role === ROLE_TYPE.Commentary,
      hearingImpaired: !!subtitleStreamInfo?.sdh,
      visuallyImpaired: !!audioStreamInfo?.descriptive,
      forced: this.streamInfo.role === ROLE_TYPE.ForcedSubtitle || !!subtitleStreamInfo?.forced,
    };
  }

  canBePairedWith(other: DashInputTrack): boolean {
    if (
      (this.input === other.input && this.id === other.id) ||
      this.input !== other.input ||
      this.streamInfo.type === other.streamInfo.type
    ) {
      return false;
    }

    if (this.streamInfo.type === 'video' && other.streamInfo.type === 'audio') {
      return !this.streamInfo.audioId || this.streamInfo.audioId === other.streamInfo.groupId;
    }

    if (this.streamInfo.type === 'audio' && other.streamInfo.type === 'video') {
      return !other.streamInfo.audioId || other.streamInfo.audioId === this.streamInfo.groupId;
    }

    if (this.streamInfo.type === 'video' && other.streamInfo.type === 'subtitle') {
      return !this.streamInfo.subtitleId || this.streamInfo.subtitleId === other.streamInfo.groupId;
    }

    if (this.streamInfo.type === 'subtitle' && other.streamInfo.type === 'video') {
      return (
        !other.streamInfo.subtitleId || other.streamInfo.subtitleId === this.streamInfo.groupId
      );
    }

    return false;
  }

  async hasPairableAudioTrack(predicate?: (track: DashInputAudioTrack) => MaybePromise<boolean>) {
    const tracks = await this.input.getAudioTracks();
    for (const track of tracks) {
      if (this.canBePairedWith(track) && ((await predicate?.(track)) ?? true)) {
        return true;
      }
    }
    return false;
  }

  getSegmentedInput() {
    this.#segmentedInput ??= new DashSegmentedInput(this as unknown as DashInputTrack);
    return this.#segmentedInput;
  }

  toSegments() {
    return playlistToSegments(this.streamInfo.playlist);
  }
}

export class DashInputVideoTrack extends DashInputTrackBase {
  get type() {
    return 'video' as const;
  }

  isVideoTrack(): this is DashInputVideoTrack {
    return true;
  }

  isAudioTrack(): this is DashInputAudioTrack {
    return false;
  }

  async getDisplayHeight() {
    return (this.streamInfo as VideoStreamInfo).height ?? 0;
  }

  async getDisplayWidth() {
    return (this.streamInfo as VideoStreamInfo).width ?? 0;
  }
}

export class DashInputAudioTrack extends DashInputTrackBase {
  get type() {
    return 'audio' as const;
  }

  isVideoTrack(): this is DashInputVideoTrack {
    return false;
  }

  isAudioTrack(): this is DashInputAudioTrack {
    return true;
  }

  async getNumberOfChannels() {
    return (this.streamInfo as AudioStreamInfo).numberOfChannels ?? 0;
  }
}

export class DashInputSubtitleTrack extends DashInputTrackBase {
  get type() {
    return 'subtitle' as const;
  }

  isVideoTrack(): this is DashInputVideoTrack {
    return false;
  }

  isAudioTrack(): this is DashInputAudioTrack {
    return false;
  }
}

export type DashInputTrack = DashInputVideoTrack | DashInputAudioTrack | DashInputSubtitleTrack;

export const isDashInputTrack = (track: unknown): track is DashInputTrack =>
  track instanceof DashInputVideoTrack ||
  track instanceof DashInputAudioTrack ||
  track instanceof DashInputSubtitleTrack;

type LoadedDashInput = {
  extractor: DashExtractor;
  manifestUrl: string;
  tracks: DashInputTrack[];
};

export class DashInput {
  readonly source: Source;

  #loadPromise?: Promise<LoadedDashInput>;
  #disposed = false;

  constructor(source: Source) {
    this.source = source;
  }

  async #load(): Promise<LoadedDashInput> {
    if (this.#disposed) {
      throw new Error('Input has been disposed.');
    }

    this.#loadPromise ??= (async () => {
      const manifestPath = getSourcePath(this.source);
      if (!manifestPath) {
        throw new Error('DASH input currently requires a pathed source such as UrlSource.');
      }

      const { text, url } = await loadManifestText(this.source);
      const parserConfig = new ParserConfig();
      parserConfig.headers = getSourceHeaders(this.source);
      parserConfig.originalUrl = url;
      parserConfig.url = url;

      const extractor = new DashExtractor(parserConfig);
      const streams = await extractor.extractStreams(text.trim());
      await extractor.fetchPlayList(streams);

      const tracks: DashInputTrack[] = [];
      let nextId = 1;
      const typeNumbers = {
        video: 1,
        audio: 1,
        subtitle: 1,
      };

      for (const stream of streams) {
        if (stream.type === 'video') {
          tracks.push(new DashInputVideoTrack(this, stream, nextId++, typeNumbers.video++));
        } else if (stream.type === 'audio') {
          tracks.push(new DashInputAudioTrack(this, stream, nextId++, typeNumbers.audio++));
        } else if (stream.type === 'subtitle') {
          tracks.push(new DashInputSubtitleTrack(this, stream, nextId++, typeNumbers.subtitle++));
        }
      }

      return {
        extractor,
        manifestUrl: url,
        tracks,
      };
    })();

    return this.#loadPromise;
  }

  async getFormat() {
    return DASH;
  }

  async canRead() {
    await this.#load();
    return true;
  }

  async getDurationFromMetadata(tracks?: DashInputTrack[]) {
    const targetTracks = tracks ?? (await this.getTracks());
    if (targetTracks.length === 0) return null;

    return Math.max(...targetTracks.map((track) => track.streamInfo.playlist?.totalDuration ?? 0));
  }

  async getTracks(query?: InputTrackQuery<DashInputTrack>) {
    const { tracks } = await this.#load();
    return queryTracks(tracks, query);
  }

  async getVideoTracks(query?: InputTrackQuery<DashInputVideoTrack>) {
    const tracks = (await this.getTracks()).filter((track) => track.isVideoTrack());
    return queryTracks(tracks, query);
  }

  async getAudioTracks(query?: InputTrackQuery<DashInputAudioTrack>) {
    const tracks = (await this.getTracks()).filter((track) => track.isAudioTrack());
    return queryTracks(tracks, query);
  }

  async getPrimaryVideoTrack(query?: InputTrackQuery<DashInputVideoTrack>) {
    const tracks = await this.getVideoTracks({
      ...query,
      sortBy: async (track) => {
        const extra = query?.sortBy ? toQuerySortArray(await query.sortBy(track)) : [];
        return [
          prefer((await track.getDisposition()).default),
          prefer(await track.hasPairableAudioTrack()),
          prefer(!(await track.hasOnlyKeyPackets())),
          desc(await track.getBitrate()),
          ...extra,
        ];
      },
    });

    return tracks[0] ?? null;
  }

  async getPrimaryAudioTrack(query?: InputTrackQuery<DashInputAudioTrack>) {
    const primaryVideoTrack = await this.getPrimaryVideoTrack();
    const tracks = await this.getAudioTracks({
      ...query,
      sortBy: async (track) => {
        const extra = query?.sortBy ? toQuerySortArray(await query.sortBy(track)) : [];
        return [
          prefer(!primaryVideoTrack || track.canBePairedWith(primaryVideoTrack)),
          prefer((await track.getDisposition()).default),
          desc(await track.getBitrate()),
          ...extra,
        ];
      },
    });

    return tracks[0] ?? null;
  }

  async refreshSegments(track: DashInputTrack): Promise<void> {
    const { extractor, manifestUrl, tracks } = await this.#load();
    if (!track.streamInfo.playlist?.isLive) return;
    if (!manifestUrl.startsWith('http://') && !manifestUrl.startsWith('https://')) return;

    await extractor.refreshPlayList(tracks.map((item) => item.streamInfo));
  }

  dispose() {
    this.#disposed = true;
  }
}

export class DashInputFormat {
  readonly name = 'dash';
}

export const DASH = new DashInputFormat();
export const DASH_FORMATS = [DASH] as const;
