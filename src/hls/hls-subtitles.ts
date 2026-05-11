import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type {
  DurationMetadataRequestOptions,
  EncodedPacket,
  Input as MediabunnyInput,
  TrackDisposition,
} from 'mediabunny';
import type { SubtitleCodec } from '../codec';
import type { HlsSegment, HlsSegmentedInput } from '../mediabunny';
import { tryParseSubtitleCodec } from '../subtitle';

const TAG_STREAM_INF = '#EXT-X-STREAM-INF:';
const TAG_MEDIA = '#EXT-X-MEDIA:';
const TAG_EXTINF = '#EXTINF:';
const TAG_MAP = '#EXT-X-MAP:';
const TAG_KEY = '#EXT-X-KEY:';
const TAG_MEDIA_SEQUENCE = '#EXT-X-MEDIA-SEQUENCE:';
const TAG_BYTERANGE = '#EXT-X-BYTERANGE:';
const TAG_PROGRAM_DATE_TIME = '#EXT-X-PROGRAM-DATE-TIME:';
const TAG_DISCONTINUITY = '#EXT-X-DISCONTINUITY';
const TAG_TARGETDURATION = '#EXT-X-TARGETDURATION:';
const TAG_ENDLIST = '#EXT-X-ENDLIST';
const TAG_PLAYLIST_TYPE = '#EXT-X-PLAYLIST-TYPE:';
const AES_128_BLOCK_SIZE = 16;
const IV_STRING_REGEX = /^0[xX][0-9a-fA-F]+$/;

export const DEFAULT_TRACK_DISPOSITION: TrackDisposition = {
  commentary: false,
  default: true,
  forced: false,
  hearingImpaired: false,
  original: false,
  primary: true,
  visuallyImpaired: false,
};

export type SourceWithRootPath = {
  rootPath: string;
  _options?: { requestInit?: RequestInit };
  _url?: string | URL | Request;
};

type HlsSubtitleMediaTag = {
  autoselect: boolean;
  codec: SubtitleCodec;
  codecString: string;
  default: boolean;
  forced: boolean;
  groupId: string;
  hearingImpaired: boolean;
  languageCode: string;
  name: string | null;
  uri: string;
};

type HlsSubtitleMediaTagCandidate = Omit<HlsSubtitleMediaTag, 'codec' | 'codecString'>;

type HlsEncryptionInfo = HlsSegment['encryption'];

const subtitleBackingsCache = new WeakMap<MediabunnyInput, Promise<HlsSubtitleTrackBacking[]>>();

const SRT_HEADER_REGEX =
  /(?:^|\n)\d+\s*\n(?:\d{2}:)?\d{2}:\d{2}[,.]\d{3}\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}[,.]\d{3}/;
const TTML_MARKER_REGEX = /<tt(?:\s|>)/i;

const splitPlaylistLines = (text: string) =>
  text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && (!line.startsWith('#') || line.startsWith('#EXT')));

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

const getSourceHeaders = (source: SourceWithRootPath) => {
  const requestHeaders =
    source._url instanceof Request ? normalizeHeaders(source._url.headers) : {};
  const optionHeaders = normalizeHeaders(source._options?.requestInit?.headers);
  return {
    ...requestHeaders,
    ...optionHeaders,
  };
};

const joinHlsPath = (basePath: string, relativePath: string) => {
  if (relativePath.includes('://')) {
    return relativePath;
  }

  if (basePath.includes('://')) {
    const queryIndex = basePath.indexOf('?');
    if (queryIndex !== -1) {
      basePath = basePath.slice(0, queryIndex);
    }
  }

  let result: string;

  if (relativePath.startsWith('/')) {
    const protocolIndex = basePath.indexOf('://');
    if (protocolIndex === -1) {
      result = relativePath;
    } else {
      const pathStart = basePath.indexOf('/', protocolIndex + 3);
      result =
        pathStart === -1 ? basePath + relativePath : basePath.slice(0, pathStart) + relativePath;
    }
  } else {
    const lastSlash = basePath.lastIndexOf('/');
    result = lastSlash === -1 ? relativePath : basePath.slice(0, lastSlash + 1) + relativePath;
  }

  let prefix = '';
  const protocolIndex = result.indexOf('://');
  if (protocolIndex !== -1) {
    const pathStart = result.indexOf('/', protocolIndex + 3);
    if (pathStart !== -1) {
      prefix = result.slice(0, pathStart);
      result = result.slice(pathStart);
    }
  }

  const normalized: string[] = [];
  for (const segment of result.split('/')) {
    if (segment === '..') {
      if (normalized.length === 0 || (normalized.length === 1 && normalized[0] === '')) {
        throw new RangeError(
          `Invalid HLS path '${relativePath}': parent traversal exceeds root for base '${basePath}'.`,
        );
      }
      normalized.pop();
    } else if (segment !== '.') {
      normalized.push(segment);
    }
  }

  return prefix + normalized.join('/');
};

const toSegmentPath = (path: string) =>
  path.includes('://') ? path : pathToFileURL(path).toString();

const parseAttributeBoolean = (value: string | null) => value?.toUpperCase() === 'YES';

const stripQueryAndHash = (value: string) => value.split('#', 1)[0]?.split('?', 1)[0] ?? '';

const inferSubtitleCodecStringFromPath = (path: string) => {
  const normalized = stripQueryAndHash(path).toLowerCase();

  if (normalized.endsWith('.webvtt')) return 'webvtt';
  if (normalized.endsWith('.vtt')) return 'vtt';
  if (normalized.endsWith('.srt')) return 'srt';
  if (normalized.endsWith('.ttml')) return 'ttml';
  if (normalized.endsWith('.dfxp')) return 'dfxp';

  return null;
};

const parseDetectedSubtitleCodec = (codecString: string | null) => {
  if (!codecString) return null;

  const codec = tryParseSubtitleCodec(codecString);
  if (!codec) return null;

  return { codec, codecString };
};

const sniffSubtitleCodecFromText = (text: string) => {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trimStart();
  if (normalized.startsWith('WEBVTT')) return 'webvtt';
  if (TTML_MARKER_REGEX.test(normalized)) return 'ttml';
  if (SRT_HEADER_REGEX.test(normalized)) return 'srt';
  return null;
};

class AttributeList {
  #attributes: Record<string, string> = {};

  constructor(text: string) {
    let key = '';
    let value = '';
    let inValue = false;
    let inQuotes = false;

    for (const char of text) {
      if (char === '"') {
        inQuotes = !inQuotes;
        continue;
      }

      if (char === '=' && !inValue && !inQuotes) {
        inValue = true;
        continue;
      }

      if (char === ',' && !inQuotes) {
        if (key) {
          this.#attributes[key.trim().toLowerCase()] = value;
        }
        key = '';
        value = '';
        inValue = false;
        continue;
      }

      if (inValue) {
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

const loadPlaylistText = async (source: SourceWithRootPath, path: string) => {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    const response = await fetch(path, {
      headers: getSourceHeaders(source),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch HLS playlist: ${response.status} ${response.statusText} (${response.url})`,
      );
    }
    return {
      path: response.url,
      text: await response.text(),
    };
  }

  if (path.startsWith('file:')) {
    return {
      path,
      text: await readFile(new URL(path), 'utf8'),
    };
  }

  return {
    path,
    text: await readFile(path, 'utf8'),
  };
};

export const detectSubtitleCodecFromUri = async (source: SourceWithRootPath, uri: string) => {
  const fromPath = parseDetectedSubtitleCodec(inferSubtitleCodecStringFromPath(uri));
  if (fromPath) {
    return fromPath;
  }

  const loaded = await loadPlaylistText(source, uri);
  const fromText = parseDetectedSubtitleCodec(sniffSubtitleCodecFromText(loaded.text));
  if (fromText) {
    return fromText;
  }

  const lines = splitPlaylistLines(loaded.text);
  if (lines[0] === '#EXTM3U') {
    for (const line of lines.slice(1)) {
      if (!line.startsWith('#')) {
        const segmentUri = joinHlsPath(loaded.path, line);
        const fromSegmentPath = parseDetectedSubtitleCodec(
          inferSubtitleCodecStringFromPath(segmentUri),
        );
        if (fromSegmentPath) {
          return fromSegmentPath;
        }

        const loadedSegment = await loadPlaylistText(source, segmentUri);
        const fromSegmentText = parseDetectedSubtitleCodec(
          sniffSubtitleCodecFromText(loadedSegment.text),
        );
        if (fromSegmentText) {
          return fromSegmentText;
        }
        continue;
      }

      if (!line.startsWith(TAG_MAP)) {
        continue;
      }

      const attributes = new AttributeList(line.slice(TAG_MAP.length));
      const mapUri = attributes.get('uri');
      if (!mapUri) {
        continue;
      }

      const fromMapPath = parseDetectedSubtitleCodec(
        inferSubtitleCodecStringFromPath(joinHlsPath(loaded.path, mapUri)),
      );
      if (fromMapPath) {
        return fromMapPath;
      }
    }
  }

  return {
    codec: 'webvtt' as const,
    codecString: 'webvtt',
  };
};

const parseMediaRange = (value: string) => {
  const separatorIndex = value.indexOf('@');
  const length = Number(separatorIndex === -1 ? value : value.slice(0, separatorIndex));
  if (!Number.isInteger(length) || length < 0) {
    throw new Error(`Invalid #EXT-X-BYTERANGE length '${value}'.`);
  }

  const offsetValue = separatorIndex === -1 ? null : Number(value.slice(separatorIndex + 1));
  if (offsetValue !== null && (!Number.isInteger(offsetValue) || offsetValue < 0)) {
    throw new Error(`Invalid #EXT-X-BYTERANGE offset '${value}'.`);
  }

  return {
    length,
    offset: offsetValue,
  };
};

const parseHexIv = (value: string) => {
  if (!IV_STRING_REGEX.test(value)) {
    throw new Error(`Unsupported IV format '${value}'.`);
  }

  let hex = value.slice(2);
  hex = hex.padStart(AES_128_BLOCK_SIZE * 2, '0');

  const iv = new Uint8Array(AES_128_BLOCK_SIZE);
  for (let index = 0; index < AES_128_BLOCK_SIZE; index++) {
    const startIndex = index * 2;
    iv[index] = Number.parseInt(hex.slice(startIndex, startIndex + 2), 16);
  }
  return iv;
};

const createSequenceIv = (sequenceNumber: number) => {
  const iv = new Uint8Array(AES_128_BLOCK_SIZE);
  const view = new DataView(iv.buffer, iv.byteOffset, iv.byteLength);
  view.setUint32(8, Math.floor(sequenceNumber / 2 ** 32));
  view.setUint32(12, sequenceNumber);
  return iv;
};

export class HlsSubtitlePlaylist implements HlsSegmentedInput {
  segments: HlsSegment[] = [];
  #source: SourceWithRootPath;
  #playlistPath: string;
  #refreshIntervalSeconds = 5;
  #streamHasEnded = false;
  #currentUpdatePromise: Promise<void> | null = null;
  #lastUpdateTime = -Infinity;

  constructor(source: SourceWithRootPath, playlistPath: string) {
    this.#source = source;
    this.#playlistPath = playlistPath;
  }

  runUpdateSegments() {
    return (this.#currentUpdatePromise ??= (async () => {
      try {
        await this.#maybeWaitForRefresh();
        await this.#reloadSegments();
      } finally {
        this.#currentUpdatePromise = null;
      }
    })());
  }

  async getDurationFromMetadata(_options: DurationMetadataRequestOptions) {
    await this.runUpdateSegments();
    const lastSegment = this.segments.at(-1);
    return lastSegment ? lastSegment.timestamp + lastSegment.duration : null;
  }

  async getLiveRefreshInterval() {
    await this.runUpdateSegments();
    return this.#streamHasEnded ? null : this.#refreshIntervalSeconds;
  }

  async isRelativeToUnixEpoch() {
    await this.runUpdateSegments();
    return this.segments.some((segment) => segment.relativeToUnixEpoch);
  }

  async #maybeWaitForRefresh() {
    if (this.#streamHasEnded || this.#lastUpdateTime === -Infinity) {
      return;
    }

    const elapsed = performance.now() - this.#lastUpdateTime;
    const remaining = Math.max(0, this.#refreshIntervalSeconds * 1000 - elapsed);
    if (remaining > 50) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  async #reloadSegments() {
    this.#lastUpdateTime = performance.now();
    const loaded = await loadPlaylistText(this.#source, this.#playlistPath);
    this.#playlistPath = loaded.path;

    const lines = splitPlaylistLines(loaded.text);
    if (lines[0] !== '#EXTM3U') {
      throw new Error('Invalid M3U8 file; expected first line to be #EXTM3U.');
    }

    let accumulatedTime = 0;
    let nextDuration: number | null = null;
    let currentKey: HlsEncryptionInfo = null;
    let nextSequenceNumber = 0;
    let currentFirstSegment: HlsSegment | null = null;
    let currentInitSegment: HlsSegment | null = null;
    let nextByteRange: { offset: number; length: number } | null = null;
    let lastByteRangeEnd: number | null = null;
    let lastProgramDateTimeSeconds: number | null = null;
    let targetDuration: number | null = null;
    let segmentSeen = false;

    const segments: HlsSegment[] = [];
    let streamHasEnded = false;

    for (const line of lines.slice(1)) {
      if (!line.startsWith('#')) {
        if (nextDuration === null) {
          throw new Error('Invalid M3U8 file; a segment must be preceded by an #EXTINF tag.');
        }

        const location = {
          path: toSegmentPath(joinHlsPath(this.#playlistPath, line)),
          offset: nextByteRange?.offset ?? 0,
          length: nextByteRange?.length ?? null,
        };
        const encryption =
          currentKey?.method === 'AES-128' && !currentKey.iv
            ? { ...currentKey, iv: createSequenceIv(nextSequenceNumber) }
            : currentKey;
        const segment: HlsSegment = {
          timestamp: accumulatedTime,
          duration: nextDuration,
          relativeToUnixEpoch: lastProgramDateTimeSeconds !== null,
          firstSegment: currentFirstSegment,
          sequenceNumber: nextSequenceNumber,
          location,
          encryption,
          initSegment: currentInitSegment,
          lastProgramDateTimeSeconds,
        };

        currentFirstSegment ??= segment;
        accumulatedTime += nextDuration;
        segments.push(segment);
        nextDuration = null;
        nextSequenceNumber += 1;

        if (nextByteRange === null) {
          lastByteRangeEnd = null;
        } else {
          nextByteRange = null;
        }

        continue;
      }

      if (line.startsWith(TAG_EXTINF)) {
        if (!segmentSeen) {
          if (
            lastProgramDateTimeSeconds === null &&
            nextSequenceNumber > 0 &&
            targetDuration !== null
          ) {
            accumulatedTime = nextSequenceNumber * targetDuration;
          }
          segmentSeen = true;
        }

        const content = line.slice(TAG_EXTINF.length);
        const commaIndex = content.indexOf(',');
        const durationString = commaIndex === -1 ? content : content.slice(0, commaIndex);
        const duration = Number(durationString);
        if (!Number.isFinite(duration) || duration < 0) {
          throw new Error(`Invalid #EXTINF tag duration '${durationString}'.`);
        }
        nextDuration = duration;
        continue;
      }

      if (line.startsWith(TAG_MEDIA_SEQUENCE)) {
        const value = Number(line.slice(TAG_MEDIA_SEQUENCE.length));
        if (!Number.isInteger(value) || value < 0) {
          throw new Error(
            `Invalid EXT-X-MEDIA-SEQUENCE value '${line.slice(TAG_MEDIA_SEQUENCE.length)}'.`,
          );
        }
        nextSequenceNumber = value;
        continue;
      }

      if (line.startsWith(TAG_KEY)) {
        const attributes = new AttributeList(line.slice(TAG_KEY.length));
        const method = attributes.get('method');

        if (method === 'NONE') {
          currentKey = null;
          continue;
        }

        if (method === 'AES-128') {
          const uri = attributes.get('uri');
          if (!uri) {
            throw new Error('Invalid #EXT-X-KEY: AES-128 requires a URI attribute.');
          }
          const iv = attributes.get('iv');

          const keyFormat = attributes.get('keyformat') ?? 'identity';
          if (keyFormat !== 'identity') {
            throw new Error(
              "For AES-128 encryption, only the 'identity' KEYFORMAT is currently supported.",
            );
          }

          currentKey = {
            method,
            keyUri: joinHlsPath(this.#playlistPath, uri),
            iv: iv ? parseHexIv(iv) : null,
            keyFormat,
          };
          continue;
        }

        if (method === 'SAMPLE-AES' || method === 'SAMPLE-AES-CTR') {
          currentKey = {
            method,
          };
          continue;
        }

        throw new Error(`Unsupported encryption method '${method}'.`);
      }

      if (line.startsWith(TAG_BYTERANGE)) {
        const range = parseMediaRange(line.slice(TAG_BYTERANGE.length));
        const nextOffset: number = range.offset ?? lastByteRangeEnd ?? 0;
        nextByteRange = {
          offset: nextOffset,
          length: range.length,
        };
        lastByteRangeEnd = nextOffset + range.length;
        continue;
      }

      if (line.startsWith(TAG_MAP)) {
        const attributes = new AttributeList(line.slice(TAG_MAP.length));
        const uri = attributes.get('uri');
        if (uri === null) {
          throw new Error('Invalid M3U8 file; #EXT-X-MAP tag requires a URI attribute.');
        }

        const byterange = attributes.get('byterange');
        const range = byterange ? parseMediaRange(byterange) : null;
        currentInitSegment = {
          timestamp: 0,
          duration: 0,
          relativeToUnixEpoch: false,
          firstSegment: null,
          sequenceNumber: -1,
          location: {
            path: toSegmentPath(joinHlsPath(this.#playlistPath, uri)),
            offset: range?.offset ?? 0,
            length: range?.length ?? null,
          },
          encryption: null,
          initSegment: null,
          lastProgramDateTimeSeconds: null,
        };
        continue;
      }

      if (line.startsWith(TAG_PROGRAM_DATE_TIME)) {
        const dateTimeString = line.slice(TAG_PROGRAM_DATE_TIME.length);
        const dateTimeSeconds = new Date(dateTimeString).getTime() / 1000;
        if (!Number.isFinite(dateTimeSeconds)) {
          throw new Error(`Invalid EXT-X-PROGRAM-DATE-TIME value '${dateTimeString}'.`);
        }

        if (segments.length > 0 && lastProgramDateTimeSeconds === null) {
          const lastSegment = segments.at(-1);
          if (!lastSegment) {
            throw new Error('Expected at least one prior HLS segment.');
          }
          const lastSegmentEnd = lastSegment.timestamp + lastSegment.duration;
          const offset = dateTimeSeconds - lastSegmentEnd;

          for (const segment of segments) {
            segment.timestamp += offset;
            segment.relativeToUnixEpoch = true;
          }

          accumulatedTime += offset;
        }

        lastProgramDateTimeSeconds = dateTimeSeconds;
        accumulatedTime = dateTimeSeconds;
        continue;
      }

      if (line === TAG_DISCONTINUITY) {
        currentFirstSegment = null;
        continue;
      }

      if (line.startsWith(TAG_TARGETDURATION)) {
        const duration = Number(line.slice(TAG_TARGETDURATION.length));
        if (!Number.isFinite(duration) || duration < 0) {
          throw new Error(
            `Invalid EXT-X-TARGETDURATION value '${line.slice(TAG_TARGETDURATION.length)}'.`,
          );
        }
        this.#refreshIntervalSeconds = duration;
        targetDuration = duration;
        continue;
      }

      if (line === TAG_ENDLIST) {
        streamHasEnded = true;
        break;
      }

      if (line.startsWith(TAG_PLAYLIST_TYPE)) {
        const playlistType = line.slice(TAG_PLAYLIST_TYPE.length).toLowerCase();
        if (playlistType === 'vod') {
          streamHasEnded = true;
        }
      }
    }

    this.segments = segments;
    this.#streamHasEnded = streamHasEnded;
  }
}

class ExternalSubtitleSegmentedInput implements HlsSegmentedInput {
  segments: HlsSegment[] = [];
  #source: SourceWithRootPath;
  #rootPath: string;
  #delegate:
    | (HlsSegmentedInput & {
        getDurationFromMetadata(options: DurationMetadataRequestOptions): Promise<number | null>;
        getLiveRefreshInterval(): Promise<number | null>;
        isRelativeToUnixEpoch(): Promise<boolean>;
      })
    | null = null;
  #loadPromise: Promise<void> | null = null;

  constructor(source: SourceWithRootPath, rootPath: string) {
    this.#source = source;
    this.#rootPath = rootPath;
  }

  runUpdateSegments() {
    return (this.#loadPromise ??= (async () => {
      if (this.#delegate) {
        await this.#delegate.runUpdateSegments();
        this.segments = this.#delegate.segments;
        return;
      }

      const loaded = await loadPlaylistText(this.#source, this.#rootPath);
      const lines = splitPlaylistLines(loaded.text);

      if (lines[0] === '#EXTM3U') {
        this.#delegate = new HlsSubtitlePlaylist(this.#source, loaded.path);
        await this.#delegate.runUpdateSegments();
        this.segments = this.#delegate.segments;
        return;
      }

      const segment: HlsSegment = {
        timestamp: 0,
        duration: 0,
        relativeToUnixEpoch: false,
        firstSegment: null,
        sequenceNumber: 0,
        location: {
          path: toSegmentPath(loaded.path),
          offset: 0,
          length: null,
        },
        encryption: null,
        initSegment: null,
        lastProgramDateTimeSeconds: null,
      };

      segment.firstSegment = segment;
      this.segments = [segment];
      this.#delegate = {
        segments: this.segments,
        runUpdateSegments: async () => {},
        getDurationFromMetadata: async (_options) => null,
        getLiveRefreshInterval: async () => null,
        isRelativeToUnixEpoch: async () => false,
      };
    })().finally(() => {
      this.#loadPromise = null;
    }));
  }

  async getDurationFromMetadata(options: DurationMetadataRequestOptions) {
    await this.runUpdateSegments();
    if (this.#delegate) {
      return this.#delegate.getDurationFromMetadata(options);
    }
    return null;
  }

  async getLiveRefreshInterval() {
    await this.runUpdateSegments();
    if (this.#delegate) {
      return this.#delegate.getLiveRefreshInterval();
    }
    return null;
  }

  async isRelativeToUnixEpoch() {
    await this.runUpdateSegments();
    if (this.#delegate) {
      return this.#delegate.isRelativeToUnixEpoch();
    }
    return false;
  }
}

export class HlsSubtitleTrackBacking {
  #id: number;
  #number: number;
  #pairingMask: bigint;
  #track: HlsSubtitleMediaTag;
  #segmentedInput: HlsSubtitlePlaylist;

  constructor(params: {
    id: number;
    number: number;
    pairingMask: bigint;
    source: SourceWithRootPath;
    track: HlsSubtitleMediaTag;
  }) {
    this.#id = params.id;
    this.#number = params.number;
    this.#pairingMask = params.pairingMask;
    this.#track = params.track;
    this.#segmentedInput = new HlsSubtitlePlaylist(params.source, params.track.uri);
  }

  getType() {
    return 'subtitle' as const;
  }

  getId() {
    return this.#id;
  }

  getNumber() {
    return this.#number;
  }

  getCodec() {
    return this.#track.codec as never;
  }

  getInternalCodecId() {
    return null;
  }

  getName() {
    return this.#track.name;
  }

  getLanguageCode() {
    return this.#track.languageCode || 'und';
  }

  getTimeResolution() {
    return 1000;
  }

  isRelativeToUnixEpoch() {
    return this.#segmentedInput.isRelativeToUnixEpoch();
  }

  getDisposition(): TrackDisposition {
    return {
      ...DEFAULT_TRACK_DISPOSITION,
      default: this.#track.autoselect,
      primary: this.#track.default,
      forced: this.#track.forced,
      hearingImpaired: this.#track.hearingImpaired,
    };
  }

  getPairingMask() {
    return this.#pairingMask;
  }

  getBitrate() {
    return null;
  }

  getAverageBitrate() {
    return null;
  }

  getDurationFromMetadata(options: DurationMetadataRequestOptions) {
    return this.#segmentedInput.getDurationFromMetadata(options);
  }

  getLiveRefreshInterval() {
    return this.#segmentedInput.getLiveRefreshInterval();
  }

  getHasOnlyKeyPackets() {
    return true;
  }

  async getDecoderConfig() {
    return null;
  }

  getMetadataCodecParameterString() {
    return this.#track.codecString;
  }

  async getFirstPacket(_options: unknown): Promise<EncodedPacket | null> {
    return null;
  }

  async getPacket(_timestamp: number, _options: unknown): Promise<EncodedPacket | null> {
    return null;
  }

  async getNextPacket(_packet: EncodedPacket, _options: unknown): Promise<EncodedPacket | null> {
    return null;
  }

  async getKeyPacket(_timestamp: number, _options: unknown): Promise<EncodedPacket | null> {
    return null;
  }

  async getNextKeyPacket(_packet: EncodedPacket, _options: unknown): Promise<EncodedPacket | null> {
    return null;
  }

  getSegmentedInput() {
    return this.#segmentedInput;
  }
}

export class ExternalSubtitleTrackBacking {
  #id: number;
  #number: number;
  #pairingMask: bigint;
  #source: SourceWithRootPath;
  #segmentedInput: ExternalSubtitleSegmentedInput;
  #languageCode: string;
  #name: string | null;
  #disposition: TrackDisposition;
  #codec: SubtitleCodec | null | undefined;
  #codecString: string | null | undefined;
  #codecInfoPromise: Promise<{
    codec: SubtitleCodec;
    codecString: string;
  }> | null = null;

  constructor(params: {
    id: number;
    number: number;
    pairingMask: bigint;
    source: SourceWithRootPath;
    codec?: SubtitleCodec | null;
    codecString?: string | null;
    languageCode?: string;
    name?: string | null;
    disposition?: Partial<TrackDisposition>;
  }) {
    this.#id = params.id;
    this.#number = params.number;
    this.#pairingMask = params.pairingMask;
    this.#source = params.source;
    this.#segmentedInput = new ExternalSubtitleSegmentedInput(
      params.source,
      params.source.rootPath,
    );
    this.#languageCode = params.languageCode ?? 'und';
    this.#name = params.name ?? null;
    this.#codec = params.codec ?? tryParseSubtitleCodec(params.codecString ?? '') ?? undefined;
    this.#codecString = params.codecString ?? params.codec ?? undefined;
    this.#disposition = {
      ...DEFAULT_TRACK_DISPOSITION,
      ...params.disposition,
    };
  }

  getType() {
    return 'subtitle' as const;
  }

  getId() {
    return this.#id;
  }

  getNumber() {
    return this.#number;
  }

  async #getCodecInfo() {
    if (this.#codec !== undefined && this.#codecString !== undefined) {
      return {
        codec: this.#codec,
        codecString: this.#codecString,
      };
    }

    const info = await (this.#codecInfoPromise ??= detectSubtitleCodecFromUri(
      this.#source,
      this.#source.rootPath,
    ));
    this.#codec = info.codec;
    this.#codecString = info.codecString;
    return info;
  }

  getCodec() {
    if (this.#codec !== undefined) {
      return this.#codec as never;
    }

    return this.#getCodecInfo().then((info) => info.codec as never);
  }

  getInternalCodecId() {
    return null;
  }

  getName() {
    return this.#name;
  }

  getLanguageCode() {
    return this.#languageCode;
  }

  getTimeResolution() {
    return 1000;
  }

  isRelativeToUnixEpoch() {
    return this.#segmentedInput.isRelativeToUnixEpoch();
  }

  getDisposition() {
    return this.#disposition;
  }

  getPairingMask() {
    return this.#pairingMask;
  }

  getBitrate() {
    return null;
  }

  getAverageBitrate() {
    return null;
  }

  getDurationFromMetadata(options: DurationMetadataRequestOptions) {
    return this.#segmentedInput.getDurationFromMetadata(options);
  }

  getLiveRefreshInterval() {
    return this.#segmentedInput.getLiveRefreshInterval();
  }

  getHasOnlyKeyPackets() {
    return true;
  }

  async getDecoderConfig() {
    return null;
  }

  async getMetadataCodecParameterString() {
    if (this.#codecString !== undefined) {
      return this.#codecString;
    }

    return this.#getCodecInfo().then((info) => info.codecString);
  }

  async getFirstPacket(_options: unknown): Promise<EncodedPacket | null> {
    return null;
  }

  async getPacket(_timestamp: number, _options: unknown): Promise<EncodedPacket | null> {
    return null;
  }

  async getNextPacket(_packet: EncodedPacket, _options: unknown): Promise<EncodedPacket | null> {
    return null;
  }

  async getKeyPacket(_timestamp: number, _options: unknown): Promise<EncodedPacket | null> {
    return null;
  }

  async getNextKeyPacket(_packet: EncodedPacket, _options: unknown): Promise<EncodedPacket | null> {
    return null;
  }

  getSegmentedInput() {
    return this.#segmentedInput;
  }
}

const parseMasterPlaylistSubtitles = async (
  input: MediabunnyInput,
): Promise<HlsSubtitleTrackBacking[]> => {
  const source = input.source as unknown as SourceWithRootPath;
  if (!('rootPath' in source) || typeof source.rootPath !== 'string') {
    return [];
  }

  const loaded = await loadPlaylistText(source, source.rootPath);
  const lines = splitPlaylistLines(loaded.text);
  if (lines[0] !== '#EXTM3U') {
    return [];
  }

  const subtitleMediaTags: HlsSubtitleMediaTagCandidate[] = [];
  const pairingMasks = new Map<string, bigint>();
  let nextPairIndex = 0n;

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    if (line.startsWith(TAG_EXTINF)) {
      return [];
    }

    if (line.startsWith(TAG_STREAM_INF)) {
      const attributes = new AttributeList(line.slice(TAG_STREAM_INF.length));
      const groupId = attributes.get('subtitles');
      if (groupId !== null) {
        pairingMasks.set(groupId, (pairingMasks.get(groupId) ?? 0n) | (1n << nextPairIndex));
      }
      nextPairIndex += 1n;
      index += 1;
      continue;
    }

    if (!line.startsWith(TAG_MEDIA)) {
      continue;
    }

    const attributes = new AttributeList(line.slice(TAG_MEDIA.length));
    if (attributes.get('type')?.toLowerCase() !== 'subtitles') {
      continue;
    }

    const groupId = attributes.get('group-id');
    const uri = attributes.get('uri');
    if (!groupId || !uri) {
      continue;
    }

    const characteristics = (attributes.get('characteristics') ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const name = attributes.get('name')?.trim() ?? null;
    const hearingImpaired =
      characteristics.includes('public.accessibility.transcribes-spoken-dialog') ||
      characteristics.includes('public.accessibility.describes-music-and-sound') ||
      name?.toLowerCase().includes('sdh') === true;

    subtitleMediaTags.push({
      autoselect:
        parseAttributeBoolean(attributes.get('default')) ||
        parseAttributeBoolean(attributes.get('autoselect')),
      default: parseAttributeBoolean(attributes.get('default')),
      forced: parseAttributeBoolean(attributes.get('forced')),
      groupId,
      hearingImpaired,
      languageCode: attributes.get('language') ?? 'und',
      name,
      uri: joinHlsPath(loaded.path, uri),
    });
  }

  const detectedSubtitleMediaTags = await Promise.all(
    subtitleMediaTags.map(async (track) => ({
      ...track,
      ...(await detectSubtitleCodecFromUri(source, track.uri)),
    })),
  );

  const nativeTrackCount = await input._getTrackBackings().then((backings) => backings.length);
  return detectedSubtitleMediaTags.map(
    (track, index) =>
      new HlsSubtitleTrackBacking({
        id: nativeTrackCount + index + 1,
        number: index + 1,
        pairingMask: pairingMasks.get(track.groupId) ?? 0n,
        source,
        track,
      }),
  );
};

export const getHlsSubtitleTrackBackings = (input: MediabunnyInput) => {
  const existing = subtitleBackingsCache.get(input);
  if (existing) {
    return existing;
  }

  const promise = parseMasterPlaylistSubtitles(input);
  subtitleBackingsCache.set(input, promise);
  return promise;
};
