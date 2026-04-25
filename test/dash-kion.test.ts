import { expect, test } from 'vitest';
import { DASH_FORMATS } from '../src';
import { createAssetInput } from './utils';

test('parse kion mpd through the Input API', async () => {
  using input = createAssetInput('dash-kion.mpd', DASH_FORMATS);

  const tracks = await input.getTracks();
  expect(tracks).toHaveLength(5);

  const primaryVideoTrack = await input.getPrimaryVideoTrack();
  const primaryAudioTrack = await input.getPrimaryAudioTrack();
  expect(primaryVideoTrack).not.toBeNull();
  expect(primaryAudioTrack).not.toBeNull();
  expect(primaryVideoTrack?.canBePairedWith(primaryAudioTrack!)).toBe(true);
  expect(await primaryVideoTrack?.getDurationFromMetadata()).toBe(7450);
});
