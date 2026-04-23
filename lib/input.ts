import { desc, asc, HLS_FORMATS, Input, UrlSource, InputTrack } from 'mediabunny';
import type { InputTrackBacking } from '../node_modules/mediabunny/src/input-track';
import type { HlsSegmentedInput } from '../node_modules/mediabunny/src/hls/hls-segmented-input';
import type { HlsSegment } from '../node_modules/mediabunny/src/hls/hls-segmented-input';

export const getSegmentedInput = (track: InputTrack): HlsSegmentedInput => {
  const backing: InputTrackBacking = (track as any)._backing;
  const internalTrack = (backing as any).internalTrack;
  return internalTrack.demuxer.getSegmentedInputForPath(internalTrack.fullPath);
};

export const getSegments = async (track: InputTrack): Promise<HlsSegment[]> => {
  const segmentedInput: HlsSegmentedInput = getSegmentedInput(track);
  await segmentedInput.runUpdateSegments();
  return segmentedInput.segments;
};

export { InputTrack, HlsSegmentedInput, HlsSegment, Input, UrlSource, HLS_FORMATS, desc, asc };
