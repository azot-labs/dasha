export function parse(text: string, url?: string, fallbackLanguage?: string): Promise<Manifest>;

export interface Manifest {
  duration?: number;
  tracks: {
    all: (VideoTrack | AudioTrack | SubtitleTrack)[];
    videos: VideoTrack[];
    audios: AudioTrack[];
    subtitles: SubtitleTrack[];
    withResolution(resolution: { width?: string; height?: string }): VideoTrack[];
    withVideoCodecs(codecs: VideoCodec[]): VideoTrack[];
    withVideoQuality(quality: number | string): VideoTrack[];
    withAudioCodecs(codecs: AudioCodec[]): AudioTrack[];
    withAudioLanguages(languages: string[], maxTracksPerLanguage?: number): AudioTrack[];
    withSubtitleLanguages(languages: string[]): SubtitleTrack[];
  };
}

export function filterByResolution(resolution: { width?: string; height?: string }): VideoTrack[];
export function filterByCodecs(tracks: VideoTrack[], codecs: VideoCodec[]): VideoTrack[];
export function filterByCodecs(tracks: AudioTrack[], codecs: AudioCodec[]): AudioTrack[];
export function filterByQuality(tracks: VideoTrack[], quality: number | string): VideoTrack[];
export function filterByLanguages(
  tracks: AudioTrack[],
  languages: string[],
  maxTracksPerLanguage?: number,
): AudioTrack[];
export function filterByChannels(tracks: AudioTrack[], channels: number | string): AudioTrack[];

export interface Track {
  id: string;
  type: 'video' | 'audio' | 'text';
  segments: Segment[];
  size?: Size;
  label?: string;
  protection?: TrackProtection;
  toString: () => string;
}

export interface Bitrate {
  bps: number;
  kbps: number;
  mbps: number;
  gbps: number;
  toString: () => string;
}

export interface Size {
  b: number;
  kb: number;
  mb: number;
  gb: number;
  toString: () => string;
}

export interface Segment {
  url: string;
  range?: string;
  init?: boolean;
  duration?: number;
  number?: number;
  presentationTime?: number;
}

export interface TrackProtection {
  common?: { id: string; value: 'cenc' | 'cbcs'; defaultKeyId?: string };
  playready?: { id: string; pssh?: string; value?: string };
  widevine?: { id: string; pssh: string; defaultKeyId?: string };
  fairplay?: { keyFormat: string; uri: string; method: string };
}

export type VideoCodec = 'H.264' | 'H.265' | 'VC-1' | 'VP8' | 'VP9' | 'AV1';
export type DynamicRange = 'SDR' | 'HLG' | 'HDR10' | 'HDR10+' | 'DV';

export interface VideoTrack extends Track {
  type: 'video';
  codec: VideoCodec;
  bitrate: Bitrate;
  width: number;
  height: number;
  quality: '144p' | '240p' | '360p' | '480p' | '720p' | '1080p' | '2160p' | '4320p' | string;
  dynamicRange: DynamicRange;
  fps?: string;
  language?: string;
}

export type AudioCodec = 'AAC' | 'DD' | 'DD+' | 'OPUS' | 'VORB' | 'DTS' | 'ALAC' | 'FLAC';

export interface AudioTrack extends Track {
  type: 'audio';
  codec: AudioCodec;
  bitrate: Bitrate;
  language: string;
  channels?: number;
  jointObjectCoding?: number;
  isDescriptive?: boolean;
}

export type SubtitleCodec =
  | 'SRT' // https://wikipedia.org/wiki/SubRip
  | 'SSA' // https://wikipedia.org/wiki/SubStation_Alpha
  | 'ASS' // https://wikipedia.org/wiki/SubStation_Alpha#Advanced_SubStation_Alpha=
  | 'TTML' // https://wikipedia.org/wiki/Timed_Text_Markup_Language
  | 'VTT' // https://wikipedia.org/wiki/WebVTT
  // MPEG-DASH box-encapsulated subtitle formats
  | 'STPP' // https://www.w3.org/TR/2018/REC-ttml-imsc1.0.1-20180424
  | 'WVTT'; // https://www.w3.org/TR/webvtt1

export interface SubtitleTrack extends Track {
  type: 'text';
  codec: SubtitleCodec;
  bitrate?: Bitrate;
  language: string;
  isClosedCaption?: boolean;
  isSdh?: boolean;
  isForced?: boolean;
}

export type AnyTrack = VideoTrack | AudioTrack | SubtitleTrack;
