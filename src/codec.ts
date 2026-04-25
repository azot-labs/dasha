/**
 * List of known video codecs, ordered by encoding preference.
 * @group Codecs
 * @public
 */
export const VIDEO_CODECS = [
  'avc', // https://wiki.x266.mov/docs/video/AVC
  'hevc', // https://wiki.x266.mov/docs/video/HEVC
  'vp8', // https://wiki.x266.mov/docs/video/VP8
  'vp9', // https://wiki.x266.mov/docs/video/VP9
  'av1', // https://wiki.x266.mov/docs/video/AV1
  'vc1', // https://wiki.x266.mov/docs/video/VC-1
] as const;

/**
 * List of known video dynamic ranges.
 * @group Codecs
 * @public
 */
export const VIDEO_DYNAMIC_RANGES = [
  'sdr',
  'hlg', // https://wiki.x266.mov/docs/introduction/high-dynamic-range#hlg
  'hdr10', // https://wiki.x266.mov/docs/introduction/high-dynamic-range#hdr10
  'hdr10+', // https://wiki.x266.mov/docs/introduction/high-dynamic-range#hdr10-1
  'dv', // https://wiki.x266.mov/docs/introduction/high-dynamic-range#dolby-vision
] as const;

/**
 * List of known audio codecs, ordered by encoding preference.
 * @group Codecs
 * @public
 */
export const AUDIO_CODECS = [
  'aac', // https://wiki.x266.mov/docs/audio/AAC
  'opus', // https://wiki.x266.mov/docs/audio/Opus
  'mp3', // https://wiki.x266.mov/docs/audio/MP3
  'vorbis', // https://wiki.x266.mov/docs/audio/Vorbis
  'flac', // https://wiki.x266.mov/docs/audio/FLAC
  'alac', // https://wiki.x266.mov/docs/audio/ALAC
  'ac3', // https://wiki.x266.mov/docs/audio/Dolby
  'eac3', // https://wiki.x266.mov/docs/audio/Dolby#e-ac-3
  'dts',
] as const;

/**
 * List of known subtitle codecs, ordered by encoding preference.
 * @group Codecs
 * @public
 */
export const SUBTITLE_CODECS = [
  'srt', // https://wiki.x266.mov/docs/subtitles/SRT
  'vtt', // https://www.w3.org/TR/webvtt1/
  'ttml', // https://www.w3.org/TR/ttml1/
  'dfxp', // https://www.w3.org/TR/ttml1/#profile-dfxp-full
  'ssa', // http://www.tcax.org/docs/ass-specs.htm
  'ass', // https://wiki.x266.mov/docs/subtitles/SSA
  // MPEG-DASH box-encapsulated subtitle formats
  // https://docs.unified-streaming.com/documentation/live/subtitles.html#subtitles-for-mpeg-dash
  'stpp',
  'wvtt',
] as const;

/**
 * Union type of known video codecs.
 * @group Codecs
 * @public
 */
export type VideoCodec = (typeof VIDEO_CODECS)[number];

/**
 * Union type of known video dynamic ranges.
 * @group Codecs
 * @public
 */
export type VideoDynamicRange = (typeof VIDEO_DYNAMIC_RANGES)[number];

/**
 * Union type of known audio codecs.
 * @group Codecs
 * @public
 */
export type AudioCodec = (typeof AUDIO_CODECS)[number];

/**
 * Union type of known subtitle codecs.
 * @group Codecs
 * @public
 */
export type SubtitleCodec = (typeof SUBTITLE_CODECS)[number];

/**
 * Union type of known media codecs.
 * @group Codecs
 * @public
 */
export type MediaCodec = VideoCodec | AudioCodec | SubtitleCodec;
