import { VideoCodec, VideoDynamicRange } from './codec';

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

const DOLBY_VISION_CODECS = ['dva1', 'dvav', 'dvhe', 'dvh1'];
type CicpProperty = { schemeIdUri: string; value?: string };
const COLOR_PRIMARIES_MAP = new Map<number, string>([
  [PRIMARIES.BT_709, 'bt709'],
  [PRIMARIES.BT_601_625, 'bt470bg'],
  [PRIMARIES.BT_601_525, 'smpte170m'],
  [PRIMARIES.BT_2020_and_2100, 'bt2020'],
  [PRIMARIES.SMPTE_ST_2113_and_EG_4321, 'smpte432'],
]);
const TRANSFER_CHARACTERISTICS_MAP = new Map<number, string>([
  [TRANSFER.BT_709, 'bt709'],
  [TRANSFER.BT_601, 'smpte170m'],
  [TRANSFER.BT_2100_PQ, 'pq'],
  [TRANSFER.BT_2100_HLG, 'hlg'],
]);
const MATRIX_COEFFICIENTS_MAP = new Map<number, string>([
  [MATRIX.RGB, 'rgb'],
  [MATRIX.YCbCr_BT_709, 'bt709'],
  [MATRIX.YCbCr_BT_601_625, 'bt470bg'],
  [MATRIX.YCbCr_BT_601_525, 'smpte170m'],
  [MATRIX.YCbCr_BT_2020_and_2100, 'bt2020-ncl'],
]);

const parseVideoCodecFromMime = (mime: string): VideoCodec => {
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

export const parseColorSpaceFromCicp = (
  primaries: number,
  transfer: number,
  matrix: number,
): VideoColorSpaceInit => {
  const normalizedTransfer = transfer == 5 ? TRANSFER.BT_601 : transfer;

  return {
    primaries: COLOR_PRIMARIES_MAP.get(primaries),
    transfer: TRANSFER_CHARACTERISTICS_MAP.get(normalizedTransfer),
    matrix: MATRIX_COEFFICIENTS_MAP.get(matrix),
  } as VideoColorSpaceInit;
};

export const parseDynamicRangeFromCodecString = (
  codecs: string | null | undefined,
): VideoDynamicRange | undefined => {
  const normalized = codecs?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return DOLBY_VISION_CODECS.some((value) => normalized.startsWith(value)) ? 'dv' : undefined;
};

const getCicpValues = (
  supplementalProps: CicpProperty[] = [],
  essentialProps: CicpProperty[] = [],
) => {
  const primariesScheme = 'urn:mpeg:mpegB:cicp:ColourPrimaries';
  const transferScheme = 'urn:mpeg:mpegB:cicp:TransferCharacteristics';
  const matrixScheme = 'urn:mpeg:mpegB:cicp:MatrixCoefficients';
  const allProps = [...essentialProps, ...supplementalProps];
  const getValues = (schemeIdUri: string) =>
    allProps
      .filter((prop) => prop.schemeIdUri === schemeIdUri)
      .flatMap((prop) => (prop.value ? [Number.parseInt(prop.value, 10)] : []));

  return {
    primaries: getValues(primariesScheme)[0] ?? 0,
    transfer: getValues(transferScheme)[0] ?? 0,
    matrix: getValues(matrixScheme)[0] ?? 0,
  };
};

export const parseColorSpace = (
  supplementalProps: CicpProperty[] = [],
  essentialProps: CicpProperty[] = [],
) => {
  const { primaries, transfer, matrix } = getCicpValues(supplementalProps, essentialProps);
  return parseColorSpaceFromCicp(primaries, transfer, matrix);
};

export const parseDynamicRangeFromHlsVideoRange = (
  videoRange: string | null | undefined,
  codecs?: string | null,
): VideoDynamicRange | undefined => {
  const normalized = videoRange?.replaceAll('"', '').trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }

  const codecDynamicRange = parseDynamicRangeFromCodecString(codecs);
  if (normalized === 'PQ') {
    return codecDynamicRange ?? 'hdr10';
  }
  if (normalized === 'HLG') {
    return 'hlg';
  }
  if (normalized === 'SDR') {
    return 'sdr';
  }
  return undefined;
};

export const parseDynamicRangeFromColorSpace = (
  colorSpace: VideoColorSpaceInit | null | undefined,
): VideoDynamicRange | undefined => {
  if (!colorSpace) {
    return undefined;
  }

  if ((colorSpace.transfer as string | undefined) === 'pq') {
    return 'hdr10';
  }
  if ((colorSpace.transfer as string | undefined) === 'hlg') {
    return 'hlg';
  }
  if (
    colorSpace.primaries != null ||
    colorSpace.transfer != null ||
    colorSpace.matrix != null ||
    colorSpace.fullRange != null
  ) {
    return 'sdr';
  }
  return undefined;
};

export const inferDynamicRange = (params: {
  codecs?: string | null;
  videoRange?: string | null;
  colorSpace?: VideoColorSpaceInit | null;
}): VideoDynamicRange => {
  return (
    parseDynamicRangeFromCodecString(params.codecs) ??
    parseDynamicRangeFromHlsVideoRange(params.videoRange, params.codecs) ??
    parseDynamicRangeFromColorSpace(params.colorSpace) ??
    'sdr'
  );
};

const parseVideoCodec = (codecs: string) => {
  for (const codec of codecs.toLowerCase().split(',')) {
    const mime = codec.trim().split('.')[0];
    try {
      return parseVideoCodecFromMime(mime);
    } catch {
      continue;
    }
  }
  throw new Error(`No MIME types matched any supported Video Codecs in ${codecs}`);
};

export const tryParseVideoCodec = (codecs: string) => {
  try {
    return parseVideoCodec(codecs);
  } catch {
    return undefined;
  }
};

export const parseDynamicRange = (
  codecs: string,
  supplementalProps: CicpProperty[] = [],
  essentialProps: CicpProperty[] = [],
): VideoDynamicRange => {
  const codecDynamicRange = parseDynamicRangeFromCodecString(codecs);
  if (codecDynamicRange) return codecDynamicRange;
  const { primaries, transfer, matrix } = getCicpValues(supplementalProps, essentialProps);
  return parseDynamicRangeFromCicp(primaries, transfer, matrix);
};
