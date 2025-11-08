import { VideoCodec, VideoDynamicRange } from '../shared/codec';

const PRIMARIES = {
  Unspecified: 0,
  BT_709: 1,
  BT_601_625: 5,
  BT_601_525: 6,
  BT_2020_and_2100: 9,
  SMPTE_ST_2113_and_EG_4321: 12, // P3D65
};

const TRANSFER = {
  Unspecified: 0,
  BT_709: 1,
  BT_601: 6,
  BT_2020: 14,
  BT_2100: 15,
  BT_2100_PQ: 16,
  BT_2100_HLG: 18,
};

const MATRIX = {
  RGB: 0,
  YCbCr_BT_709: 1,
  YCbCr_BT_601_625: 5,
  YCbCr_BT_601_525: 6,
  YCbCr_BT_2020_and_2100: 9, // YCbCr BT.2100 shares the same CP
  ICtCp_BT_2100: 14,
};

export const parseVideoCodecFromMime = (mime: string): VideoCodec => {
  const target = mime.toLowerCase().trim().split('.')[0];
  const avc = ['avc1', 'avc2', 'avc3', 'dva1', 'dvav'];
  const hevc = ['hev1', 'hev2', 'hev3', 'hvc1', 'hvc2', 'hvc3', 'dvh1', 'dvhe', 'lhv1', 'lhe1'];
  const vc1 = ['vc-1'];
  const vp8 = ['vp08', 'vp8'];
  const vp9 = ['vp09', 'vp9'];
  const av1 = ['av01'];
  if (avc.includes(target)) return 'avc';
  if (hevc.includes(target)) return 'hevc';
  if (vc1.includes(target)) return 'vc1';
  if (vp8.includes(target)) return 'vp8';
  if (vp9.includes(target)) return 'vp9';
  if (av1.includes(target)) return 'av1';
  throw new Error(`The MIME ${mime} is not supported as video codec`);
};

export const parseDynamicRangeFromCicp = (
  primaries: number,
  transfer: number,
  matrix: number,
): VideoDynamicRange => {
  // While not part of any standard, it is typically used as a PAL variant of Transfer.BT_601=6.
  // i.e. where Transfer 6 would be for BT.601-NTSC and Transfer 5 would be for BT.601-PAL.
  // The codebase is currently agnostic to either, so a manual conversion to 6 is done.
  if (transfer == 5) transfer = TRANSFER.BT_601;
  if (
    primaries == PRIMARIES.Unspecified &&
    transfer == TRANSFER.Unspecified &&
    matrix == MATRIX.RGB
  ) {
    return 'sdr';
  } else if ([PRIMARIES.BT_601_625, PRIMARIES.BT_601_525].includes(primaries)) {
    return 'sdr';
  } else if (TRANSFER.BT_2100_PQ === transfer) {
    return 'hdr10';
  } else if (TRANSFER.BT_2100_HLG === transfer) {
    return 'hlg';
  } else {
    return 'sdr';
  }
};

export const parseVideoCodec = (codecs: string) => {
  for (const codec of codecs.toLowerCase().split(',')) {
    const mime = codec.trim().split('.')[0];
    try {
      return parseVideoCodecFromMime(mime);
    } catch (e) {
      continue;
    }
  }
  throw new Error(`No MIME types matched any supported Video Codecs in ${codecs}`);
};

export const tryParseVideoCodec = (codecs: string) => {
  try {
    return parseVideoCodec(codecs);
  } catch (e) {
    return undefined;
  }
};

export const parseDynamicRange = (
  codecs: string,
  supplementalProps: { schemeIdUri: string; value?: string }[] = [],
  essentialProps: { schemeIdUri: string; value?: string }[] = [],
): VideoDynamicRange => {
  const dv = ['dva1', 'dvav', 'dvhe', 'dvh1'];
  if (dv.some((value) => codecs.startsWith(value))) return 'dv';
  const primariesScheme = 'urn:mpeg:mpegB:cicp:ColourPrimaries';
  const transferScheme = 'urn:mpeg:mpegB:cicp:TransferCharacteristics';
  const matrixScheme = 'urn:mpeg:mpegB:cicp:MatrixCoefficients';
  const allProps = [...essentialProps, ...supplementalProps];
  const getValues = (schemeIdUri: string) =>
    allProps
      .filter((prop) => prop.schemeIdUri === schemeIdUri)
      .map((prop) => parseInt(prop.value!));
  const primaries = getValues(primariesScheme).reduce((acc, current) => acc + current, 0);
  const transfer = getValues(transferScheme).reduce((acc, current) => acc + current, 0);
  const matrix = getValues(matrixScheme).reduce((acc, current) => acc + current, 0);
  return parseDynamicRangeFromCicp(primaries, transfer, matrix);
};
