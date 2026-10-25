import { expect, test } from 'vitest';
import { DASH_FORMATS } from '../src';
import { createAssetInput } from './utils';

test('synthesize ClearKey v1 PSSH from declared system and default KID', async () => {
  using input = createAssetInput('clearkey.mpd', DASH_FORMATS);

  const track = await input.getPrimaryVideoTrack();
  expect(track).not.toBeNull();
  const segment = (await track!.getSegments())[0];

  expect(segment?.encryption?.drm.clearkey?.keyId).toBe('474e7638-0000-0000-0000-41365730553d');
  expect(segment?.encryption?.psshBoxes).toEqual([
    {
      systemId: '1077efecc0b24d02ace33c1e52e2fb4b',
      keyIds: ['474e763800000000000041365730553d'],
      data: new Uint8Array(),
    },
  ]);
});

test('preserve declared ClearKey PSSH metadata and ignore invalid KIDs', async () => {
  using input = createAssetInput('clearkey-with-pssh.mpd', DASH_FORMATS);

  const track = await input.getPrimaryVideoTrack();
  const segment = (await track!.getSegments())[0];

  expect(segment?.encryption?.drm.clearkey).toEqual({
    keyId: '474e7638-0000-0000-0000-41365730553d',
    pssh: 'AAAAMHBzc2gBAAAAEHfv7MCyTQKs4zweUuL7SwAAAAFHTnY4AAAAAAAAQTZXMFU9',
  });
  expect(segment?.encryption?.psshBoxes).toHaveLength(1);
});
