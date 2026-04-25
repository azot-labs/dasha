import { expect, test } from 'vitest';
import { DASH_FORMATS } from '../dasha';
import { createAssetInput } from './utils';

test('parse live dash from vitrina through the Input API', async () => {
  using input = createAssetInput('dash-live-drm-vitrina.mpd', DASH_FORMATS);

  const tracks = await input.getTracks();
  expect(tracks).toHaveLength(7);

  const liveFlags = await Promise.all(tracks.map((track) => track.isLive()));
  expect(liveFlags.every(Boolean)).toBe(true);

  const video = await input.getPrimaryVideoTrack();
  expect(await video?.getLiveRefreshInterval()).toBeGreaterThan(0);

  const firstSegment = (await video!.getSegments())[0];
  expect(firstSegment?.encryption?.drm.widevine?.pssh).toBe(
    'AAAAeXBzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAAFkIARIgZTY0YzNkZDczNmUyMWZiMGExYjQ4MjQ2MTljOGFkODQaDWNkbm5vd3ZpdHJpbmEiJDAyNmRhN2U5LTBkMzUtNGRiMi1hZGVhLTIxZjkyYTA4ZDMyYQ==',
  );
});
