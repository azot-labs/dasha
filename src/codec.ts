import type {
  SubtitleCodec as MediabunnySubtitleCodec,
  VideoCodec as MediabunnyVideoCodec,
  AudioCodec as MediabunnyAudioCodec,
} from 'mediabunny';

/**
 * Union type of known video codecs.
 * @group Codecs
 * @public
 */
export type VideoCodec = MediabunnyVideoCodec | 'vc1';

/**
 * Union type of known video dynamic ranges.
 *
 * `sdr`: Standard Dynamic Range
 *
 * `hlg`: High-Luminance Gamma
 *
 * `hdr10`: High-Dynamic Range 10
 *
 * `hdr10+`: High-Dynamic Range 10+
 *
 * `dv`: Dolby Vision
 *
 * @group Codecs
 * @public
 */
export type VideoDynamicRange = 'sdr' | 'hlg' | 'hdr10' | 'hdr10+' | 'dv';

/**
 * Union type of known audio codecs.
 * @group Codecs
 * @public
 */
export type AudioCodec = MediabunnyAudioCodec | 'dts' | 'alac';

/**
 * Union type of known subtitle codecs.
 * @group Codecs
 * @public
 */
export type SubtitleCodec =
  | MediabunnySubtitleCodec
  | 'srt'
  | 'ttml'
  | 'dfxp'
  | 'ssa'
  | 'ass'
  | 'stpp';

/**
 * Union type of known media codecs.
 * @group Codecs
 * @public
 */
export type MediaCodec = VideoCodec | AudioCodec | SubtitleCodec;
