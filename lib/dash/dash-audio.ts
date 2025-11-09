import { parseMimes } from '../shared/util';
import { AudioCodec } from '../shared/codec';

const parseAudioCodecFromMime = (mime: string): AudioCodec => {
  const target = mime.toLowerCase().trim().split('.')[0];
  switch (target) {
    case 'mp4a':
      return 'aac';
    case 'ac-3':
      return 'ac3';
    case 'ec-3':
      return 'eac3';
    case 'opus':
      return 'opus';
    case 'dtsc':
      return 'dts';
    case 'alac':
      return 'alac';
    case 'flac':
      return 'flac';
    default:
      throw new Error(`The MIME ${mime} is not supported as audio codec`);
  }
};

const parseAudioCodec = (codecs: string) => {
  const mimes = parseMimes(codecs);
  for (const mime of mimes) {
    try {
      return parseAudioCodecFromMime(mime);
    } catch (e) {
      continue;
    }
  }
  throw new Error(`No MIME types matched any supported Audio Codecs in ${codecs}`);
};

export const tryParseAudioCodec = (codecs: string) => {
  try {
    return parseAudioCodec(codecs);
  } catch (e) {
    return undefined;
  }
};

// https://professionalsupport.dolby.com/s/article/What-is-Dolby-Digital-Plus-JOC-Joint-Object-Coding?language=en_US
export const getDolbyDigitalPlusComplexityIndex = (
  supplementalProps: { schemeIdUri: string; value?: string }[] = [],
) => {
  const targetScheme = 'tag:dolby.com,2018:dash:EC3_ExtensionComplexityIndex:2018';
  for (const prop of supplementalProps)
    if (prop.schemeIdUri === targetScheme) return parseInt(prop.value!);
};

export const checkIsDescriptive = (
  accessibilities: { schemeIdUri: string; value?: string }[] = [],
) => {
  for (const accessibility of accessibilities) {
    const { schemeIdUri, value } = accessibility;
    const firstMatch = schemeIdUri == 'urn:mpeg:dash:role:2011' && value === 'descriptive';
    const secondMatch = schemeIdUri == 'urn:tva:metadata:cs:AudioPurposeCS:2007' && value === '1';
    const isDescriptive = firstMatch || secondMatch;
    if (isDescriptive) return true;
  }
  return false;
};

export const parseChannels = (channels: string) => {
  const isDigit = (char: string) => char >= '0' && char <= '9';
  if (typeof channels === 'string') {
    if (channels.toUpperCase() == 'A000') return 2.0;
    else if (channels.toUpperCase() == 'F801') return 5.1;
    else if (isDigit(channels.replace('ch', '').replace('.', '')[0]))
      // e.g., '2ch', '2', '2.0', '5.1ch', '5.1'
      return parseFloat(channels.replace('ch', ''));
    throw new Error(`Unsupported audio channels value, '${channels}'`);
  }
  return parseFloat(channels);
};
