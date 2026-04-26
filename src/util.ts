export const combineUrl = (baseUrl: string, relativeUrl: string) => {
  if (!baseUrl.trim()) return relativeUrl;
  const url1 = new URL(baseUrl);
  const url2 = new URL(relativeUrl, url1);
  return url2.toString();
};

export const parseMimes = (codecs: string) =>
  codecs
    .toLowerCase()
    .split(',')
    .map((codec) => codec.trim().split('.')[0]);
