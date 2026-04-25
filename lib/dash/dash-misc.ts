import { readFile } from 'node:fs/promises';
import { Element, LiveNodeList } from '@xmldom/xmldom';
import type { Source } from 'mediabunny';
import { combineUrl } from '../shared/util';
import type { MediaCodec } from '../shared/codec';
import { tryParseVideoCodec } from '../shared/video';
import { tryParseSubtitleCodec } from '../shared/subtitle';
import { tryParseAudioCodec } from '../shared/audio';
import { pipe } from '../shared/pipe';
import type { DashTrackType } from './dash-model';

export const DASH_MIME_TYPE = 'application/dash+xml';

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

export const createDashTrackDescriptor = (params: {
  codecs: string | null;
  contentType: string | null;
  mimeType: string | null;
}): { type: DashTrackType; codec?: MediaCodec; codecString: string | null } => {
  const shouldUseCodecsFromMime =
    params.contentType === 'text' && !params.mimeType?.includes('mp4');
  const codecs = shouldUseCodecsFromMime ? params.mimeType?.split('/')[1] : params.codecs;
  if (!params.codecs && codecs) params.codecs = codecs;

  if (params.codecs) {
    const videoCodec = tryParseVideoCodec(params.codecs);
    if (videoCodec) return { type: 'video', codec: videoCodec, codecString: params.codecs };
    const audioCodec = tryParseAudioCodec(params.codecs);
    if (audioCodec) return { type: 'audio', codec: audioCodec, codecString: params.codecs };
    const subtitleCodec = tryParseSubtitleCodec(params.codecs);
    if (subtitleCodec)
      return { type: 'subtitle', codec: subtitleCodec, codecString: params.codecs };
  } else {
    const type = params.contentType || params.mimeType?.split('/')[0];
    if (type === 'video') return { type: 'video', codecString: null };
    if (type === 'audio') return { type: 'audio', codecString: null };
    if (type === 'text')
      return { type: 'subtitle', codecString: params.mimeType?.split('/')[1] ?? null };
  }

  throw new Error('Unable to determine the type of a track, cannot continue...');
};

const selectNonEmpty = (args: { tag: string; elements: Element[] }) => {
  for (const element of args.elements) {
    const results = element.getElementsByTagName(args.tag);
    if (results.length) return results;
  }
};

const toSchemeValueArray = (elements?: LiveNodeList<Element>) => {
  const results: { schemeIdUri: string; value?: string }[] = [];
  if (!elements) return results;
  for (const element of elements) {
    const schemeIdUri = element.getAttribute('schemeIdUri');
    const value = element.getAttribute('value') ?? undefined;
    if (schemeIdUri) results.push({ schemeIdUri, value });
  }
  return results;
};

export const getDashTagAttrs = (tag: string, ...elements: Element[]) => {
  const adapter = pipe(selectNonEmpty, toSchemeValueArray);
  return adapter({ tag, elements });
};

export const extendDashBaseUrl = (node: Element, baseUrl: string) => {
  const targets = node
    .getElementsByTagName('BaseURL')
    .filter((n) => !!n.parentNode?.isSameNode(node));
  const target = targets[0];
  if (target?.textContent) return combineUrl(baseUrl, target.textContent);
  return baseUrl;
};

export const getDashFrameRate = (node: Element): number | undefined => {
  const frameRate = node.getAttribute('frameRate');
  if (!frameRate || !frameRate.includes('/')) return;
  const value = Number(frameRate.split('/')[0]) / Number(frameRate.split('/')[1]);
  return Number(value.toFixed(3));
};

export const filterDashLanguage = (language?: string | null): string | undefined => {
  if (!language) return;
  return language;
};
