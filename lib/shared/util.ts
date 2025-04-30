import { DASH_TAGS } from './dash-tags';

export const combineUrl = (baseUrl: string, relativeUrl: string) => {
  if (!baseUrl.trim()) return relativeUrl;
  const url1 = new URL(baseUrl);
  const url2 = new URL(relativeUrl, url1);
  return url2.toString();
};

/**
 * Extracts StartRange and ExpectLength information from a string like "100-300"
 * @param range - The range string in the format "start-end"
 * @returns A tuple containing [StartRange, ExpectLength]
 */
export function parseRange(range: string): [number, number] {
  const [start, end] = range.split('-').map(Number);
  return [start, end - start + 1];
}

export function replaceVars(text: string, dict: Record<string, any>): string {
  let result = text;
  for (const [key, value] of Object.entries(dict)) {
    result = result.replaceAll(key, String(value));
  }

  const regex = /\$Number%([0-9]+)d\$/g;
  if (regex.test(result)) {
    result = result.replace(regex, (match, p1) => {
      return dict[DASH_TAGS.TemplateNumber]?.toString().padStart(parseInt(p1), '0');
    });
  }

  return result;
}

/**
 * Extracts length and optional start values from a string formatted as "n[@o]".
 * @param input - The input string.
 * @returns A tuple containing [n (length), o (start)].
 */
export function getRange(input: string): [number, number | null] {
  const parts = input.split('@');
  switch (parts.length) {
    case 0:
      return [0, null];
    case 1:
      return [parseInt(parts[0], 10), null];
    case 2:
      return [parseInt(parts[0], 10), parseInt(parts[1], 10)];
    default:
      return [0, null];
  }
}

/**
 * Extracts parameters from text like:
 * #EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2149280,CODECS="mp4a.40.2,avc1.64001f",RESOLUTION=1280x720,NAME="720"
 * @param line - The line of text to be parsed
 * @param key - If empty, returns all characters after the first colon
 * @returns The extracted attribute value
 */
export function getAttribute(line: string, key: string = ''): string {
  line = line.trim();
  if (key === '') {
    return line.slice(line.indexOf(':') + 1);
  }

  let index = -1;
  let result = '';
  if ((index = line.indexOf(key + '="')) > -1) {
    const startIndex = index + (key + '="').length;
    const endIndex = line.indexOf('"', startIndex);
    result = line.slice(startIndex, endIndex);
  } else if ((index = line.indexOf(key + '=')) > -1) {
    const startIndex = index + (key + '=').length;
    const endIndex = line.indexOf(',', startIndex);
    result = endIndex >= startIndex ? line.slice(startIndex, endIndex) : line.slice(startIndex);
  }

  return result;
}

export const distinctBy = <T>(array: T[], callbackfn: (item: T) => unknown) => {
  const seen = new Set();
  return array.filter((item) => {
    const value = callbackfn(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
};
