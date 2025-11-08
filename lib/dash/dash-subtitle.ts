import { parseMimes } from '../shared/util';
import { SubtitleCodec } from '../shared/codec';

const parseSubtitleCodecFromMime = (mime: string): SubtitleCodec => {
  const target = mime.toLowerCase().trim().split('.')[0];
  switch (target) {
    case 'srt':
    case 'x-subrip':
      return 'srt';
    case 'ssa':
      return 'ssa';
    case 'ass':
      return 'ass';
    case 'ttml':
      return 'ttml';
    case 'vtt':
      return 'vtt';
    case 'stpp':
      return 'stpp';
    case 'wvtt':
      return 'wvtt';
    default:
      throw new Error(`The MIME ${mime} is not supported as subtitle codec`);
  }
};

const parseSubtitleCodec = (codecs: string) => {
  const mimes = parseMimes(codecs);
  for (const mime of mimes) {
    try {
      return parseSubtitleCodecFromMime(mime);
    } catch (e) {
      continue;
    }
  }
  throw new Error(`No MIME types matched any supported Subtitle Codecs in ${codecs}`);
};

export const tryParseSubtitleCodec = (codecs: string) => {
  try {
    return parseSubtitleCodec(codecs);
  } catch (e) {
    return undefined;
  }
};

export const checkIsClosedCaption = (roles: { schemeIdUri: string; value?: string }[] = []) => {
  for (const role of roles) {
    const isClosedCaption =
      role.schemeIdUri === 'urn:mpeg:dash:role:2011' && role.value === 'caption';
    if (isClosedCaption) return true;
  }
  return false;
};

export const checkIsSdh = (accessibilities: { schemeIdUri: string; value?: string }[] = []) => {
  for (const accessibility of accessibilities) {
    const { schemeIdUri, value } = accessibility;
    const isSdh = schemeIdUri === 'urn:tva:metadata:cs:AudioPurposeCS:2007' && value === '2';
    if (isSdh) return true;
  }
  return false;
};

export const checkIsForced = (roles: { schemeIdUri: string; value?: string }[] = []) => {
  for (const role of roles) {
    const isForced =
      role.schemeIdUri === 'urn:mpeg:dash:role:2011' &&
      (role.value === 'forced-subtitle' || role.value === 'forced_subtitle');
    if (isForced) return true;
  }
  return false;
};
