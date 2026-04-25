import { readFile } from 'node:fs/promises';
import { Element } from '@xmldom/xmldom';
import type { Source } from 'mediabunny';
import { combineUrl } from '../util';
import type { MediaCodec, VideoDynamicRange } from '../codec';
import { tryParseVideoCodec } from '../video';
import { tryParseSubtitleCodec } from '../subtitle';
import { tryParseAudioCodec } from '../audio';
import type { RoleType } from '../role-type';

export const DASH_MIME_TYPE = 'application/dash+xml';
export const DASH_TEMPLATE_REPRESENTATION_ID = '$RepresentationID$';
export const DASH_TEMPLATE_BANDWIDTH = '$Bandwidth$';
export const DASH_TEMPLATE_NUMBER = '$Number$';
export const DASH_TEMPLATE_TIME = '$Time$';

export type DashTrackType = 'video' | 'audio' | 'subtitle';

export type DashEncryptionData = {
  method: string;
  key?: Uint8Array;
  iv?: Uint8Array;
  drm: {
    widevine?: { keyId?: string; pssh?: string };
    playready?: { keyId?: string; pssh?: string };
    fairplay?: { keyId?: string; pssh?: string };
  };
};

export type DashParsedSegment = {
  sequenceNumber: number | null;
  timestamp?: number;
  duration: number;
  url: string;
  startRange?: number;
  expectLength?: number;
  encryption: DashEncryptionData | null;
};

type DashTrackCommon = {
  type: DashTrackType;
  codec?: MediaCodec;
  codecString: string | null;
  languageCode?: string;
  peakBitrate: number | null;
  averageBitrate: number | null;
  name: string | null;
  default: boolean;
  role?: RoleType;
  groupId: string | null;
  audioGroupId?: string;
  subtitleGroupId?: string;
  periodId: string | null;
  extension: string | null;
  isLive: boolean;
  refreshIntervalMs: number;
  initSegment: DashParsedSegment | null;
  mediaSegments: DashParsedSegment[];
};

export type DashParsedVideoTrack = DashTrackCommon & {
  type: 'video';
  width?: number;
  height?: number;
  frameRate?: number;
  dynamicRange?: VideoDynamicRange;
};

export type DashParsedAudioTrack = DashTrackCommon & {
  type: 'audio';
  numberOfChannels?: number;
  sampleRate?: number;
  descriptive?: boolean;
  joc?: number;
};

export type DashParsedSubtitleTrack = DashTrackCommon & {
  type: 'subtitle';
  cc?: boolean;
  sdh?: boolean;
  forced?: boolean;
};

export type DashParsedTrack = DashParsedVideoTrack | DashParsedAudioTrack | DashParsedSubtitleTrack;

export const getDashTrackMatchKey = (track: DashParsedTrack) =>
  JSON.stringify({
    type: track.type,
    codecString: track.codecString,
    groupId: track.groupId,
    periodId: track.periodId,
    width: track.type === 'video' ? track.width : null,
    height: track.type === 'video' ? track.height : null,
    languageCode: track.languageCode ?? null,
    name: track.name,
    role: track.role ?? null,
    extension: track.extension,
  });

export const getSourcePath = (source: Source): string | undefined => {
  if ('rootPath' in source && typeof source.rootPath === 'string') {
    return source.rootPath;
  }
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

export const getSourceHeaders = (source: Source): Record<string, string> => {
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

export const loadDashManifest = async (source: Source) => {
  const manifestPath = getSourcePath(source);
  if (!manifestPath) {
    throw new Error('DASH input currently requires a pathed source such as UrlSource.');
  }

  if (manifestPath.startsWith('http://') || manifestPath.startsWith('https://')) {
    const response = await fetch(manifestPath, {
      headers: getSourceHeaders(source),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch DASH manifest: ${response.status} ${response.statusText} (${response.url})`,
      );
    }

    return {
      text: await response.text(),
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

export const isLikelyDashPath = (source: Source) => {
  const path = getSourcePath(source);
  if (!path) return false;
  return path.toLowerCase().split(/[?#]/, 1)[0]?.endsWith('.mpd') ?? false;
};

export const isDashManifestText = (text: string) => /<MPD(?:\s|>)/i.test(text);

export const replaceDashVariables = (text: string, variables: Record<string, string>) => {
  let result = '';

  for (let index = 0; index < text.length; ) {
    if (text[index] !== '$') {
      result += text[index];
      index += 1;
      continue;
    }

    if (text[index + 1] === '$') {
      result += '$';
      index += 2;
      continue;
    }

    const endIndex = text.indexOf('$', index + 1);
    if (endIndex < 0) {
      result += '$';
      index += 1;
      continue;
    }

    const token = text.slice(index + 1, endIndex);
    const match = token.match(/^(RepresentationID|Bandwidth|Number|Time)(?:%([0-9]+)d)?$/);
    if (!match) {
      result += text.slice(index, endIndex + 1);
      index = endIndex + 1;
      continue;
    }

    const [, variableName, width] = match;
    const key = `$${variableName}$`;
    const value = variables[key];
    if (value == null) {
      result += text.slice(index, endIndex + 1);
      index = endIndex + 1;
      continue;
    }

    result +=
      !width || variableName === 'RepresentationID'
        ? value
        : value.padStart(Number.parseInt(width, 10), '0');
    index = endIndex + 1;
  }

  return result;
};

export const createDashTrackDescriptor = (params: {
  codecs: string | null;
  contentType: string | null;
  mimeType: string | null;
}): { type: DashTrackType; codec?: MediaCodec; codecString: string | null } => {
  const shouldUseCodecsFromMime =
    params.contentType === 'text' && !params.mimeType?.includes('mp4');
  const codecString =
    params.codecs ?? (shouldUseCodecsFromMime ? params.mimeType?.split('/')[1] : null);

  if (codecString) {
    const videoCodec = tryParseVideoCodec(codecString);
    if (videoCodec) return { type: 'video', codec: videoCodec, codecString };

    const audioCodec = tryParseAudioCodec(codecString);
    if (audioCodec) return { type: 'audio', codec: audioCodec, codecString };

    const subtitleCodec = tryParseSubtitleCodec(codecString);
    if (subtitleCodec) return { type: 'subtitle', codec: subtitleCodec, codecString };
  } else {
    const type = params.contentType || params.mimeType?.split('/')[0];
    if (type === 'video') return { type: 'video', codecString: null };
    if (type === 'audio') return { type: 'audio', codecString: null };
    if (type === 'text') {
      const subtitleCodecString = params.mimeType?.split('/')[1] ?? null;
      return {
        type: 'subtitle',
        codec: subtitleCodecString ? tryParseSubtitleCodec(subtitleCodecString) : undefined,
        codecString: subtitleCodecString,
      };
    }
  }

  throw new Error('Unable to determine the type of a track, cannot continue...');
};

export const getDirectDashChildren = (node: Element, tag: string): Element[] =>
  node.getElementsByTagName(tag).filter((child) => !!child.parentNode?.isSameNode(node));

export const getDirectDashChild = (node: Element, tag: string): Element | undefined =>
  getDirectDashChildren(node, tag)[0];

export const getInheritedDashChild = (tag: string, ...nodes: Element[]): Element | undefined => {
  for (const node of nodes) {
    const child = getDirectDashChild(node, tag);
    if (child) {
      return child;
    }
  }
};

export const getDashTagAttrs = (tag: string, ...elements: Element[]) => {
  for (const element of elements) {
    const matches = getDirectDashChildren(element, tag);
    if (!matches.length) {
      continue;
    }

    return matches.flatMap((match) => {
      const schemeIdUri = match.getAttribute('schemeIdUri');
      if (!schemeIdUri) {
        return [];
      }

      return {
        schemeIdUri,
        value: match.getAttribute('value') ?? undefined,
      };
    });
  }

  return [];
};

export const extendDashBaseUrl = (node: Element, baseUrl: string) => {
  const target = getDirectDashChild(node, 'BaseURL');
  if (target?.textContent) return combineUrl(baseUrl, target.textContent);
  return baseUrl;
};

export const getDashFrameRate = (node: Element): number | undefined => {
  const frameRate = node.getAttribute('frameRate');
  if (!frameRate || !frameRate.includes('/')) return;
  const value = Number(frameRate.split('/')[0]) / Number(frameRate.split('/')[1]);
  return Number(value.toFixed(3));
};

export const parseDashRange = (range: string): [number, number] => {
  const [startRange, end] = range.split('-').map(Number);
  return [startRange, end - startRange + 1];
};
