export const MEDIA_TYPES = {
  VIDEO: 'video',
  AUDIO: 'audio',
  SUBTITLES: 'subtitle',
  CLOSED_CAPTIONS: 'closed-captions',
} as const;

export type MediaType = (typeof MEDIA_TYPES)[keyof typeof MEDIA_TYPES];
