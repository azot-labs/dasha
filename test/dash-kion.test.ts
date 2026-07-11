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

  const segments = await primaryVideoTrack?.getSegments();
  const drm = segments?.[0]?.initSegment?.encryption?.drm;
  expect(drm?.widevine?.pssh).toBe(
    'AAAAXXBzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAAD0IARIQQfHHn+Nr0Ef1QpsPKxuarRoNdmVyaW1hdHJpeG10cyIRcj03NTY4MDYwNDImcz05NTMqBVNEX0hE',
  );
  expect(drm?.playready?.pssh).toBeTruthy();
});
