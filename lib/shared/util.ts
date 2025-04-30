import { DASHTags } from './dash-tags';

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
      return dict[DASHTags.TemplateNumber]
        ?.toString()
        .padStart(parseInt(p1), '0');
    });
  }

  return result;
}
