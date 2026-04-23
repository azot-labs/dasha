import { desc, asc, HLS_FORMATS, Input, UrlSource, InputTrack } from 'mediabunny';
import type { HlsSegmentedInput, HlsSegment, InputTrackWithBacking } from './mediabunny';

export const getSegmentedInput = (track: InputTrack): HlsSegmentedInput => {
  const backing = (track as InputTrackWithBacking)._backing;
  const internalTrack = backing.internalTrack;
  return internalTrack.demuxer.getSegmentedInputForPath(internalTrack.fullPath);
};

export const getSegments = async (track: InputTrack): Promise<HlsSegment[]> => {
  const segmentedInput: HlsSegmentedInput = getSegmentedInput(track);
  await segmentedInput.runUpdateSegments();
  return segmentedInput.segments;
};

export { InputTrack, Input, UrlSource, HLS_FORMATS, desc, asc };
export type { HlsSegment, HlsSegmentedInput, InputTrackWithBacking };
