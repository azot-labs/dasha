export const EXTRACTOR_TYPES = {
  MPEG_DASH: 'MPEG_DASH',
  HLS: 'HLS',
  HTTP_LIVE: 'HTTP_LIVE',
  MSS: 'MSS',
} as const;

export type ExtractorType = (typeof EXTRACTOR_TYPES)[keyof typeof EXTRACTOR_TYPES];
