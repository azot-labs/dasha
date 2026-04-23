import { expect, test } from 'vitest';
import { DASH_FORMATS, getSegments } from '../dasha';
import { createAssetInput } from './utils';

test('parse bitmovin mpd with drm through the Input API', async () => {
  using input = createAssetInput('bitmovin.mpd', DASH_FORMATS);

  const tracks = await input.getTracks();
  expect(tracks).toHaveLength(7);

  const primaryVideoTrack = await input.getPrimaryVideoTrack();
  const firstSegment = (await getSegments(primaryVideoTrack!))[0];
  expect(firstSegment?.encryption?.method).toBe('cenc');
  expect(firstSegment?.encryption?.drm.widevine?.pssh).toBe(
    'AAAAW3Bzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAADsIARIQ62dqu8s0Xpa7z2FmMPGj2hoNd2lkZXZpbmVfdGVzdCIQZmtqM2xqYVNkZmFsa3IzaioCSEQyAA==',
  );
});
