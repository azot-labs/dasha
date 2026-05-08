import { expect, test } from 'vitest';
import { DASH_FORMATS } from '../src';
import { createAssetInput } from './utils';

test('map DASH accessibility and role metadata to track dispositions', async () => {
  using input = createAssetInput('subtitle-audio-dispositions.mpd', DASH_FORMATS);

  const primaryAudioTrack = await input.getPrimaryAudioTrack();
  const subtitleTracks = (await input.getTracks()).filter((track) => track.type === 'subtitle');
  const subtitleTrack = subtitleTracks[0];

  expect(primaryAudioTrack).not.toBeNull();
  expect(subtitleTrack).toBeDefined();
  expect(await primaryAudioTrack!.getCodec()).toBe('eac3');
  expect(await primaryAudioTrack!.getNumberOfChannels()).toBe(5.1);
  await expect(primaryAudioTrack!.getDisposition()).resolves.toMatchObject({
    commentary: true,
    visuallyImpaired: true,
  });

  expect(await subtitleTrack!.getCodec()).toBe('webvtt');
  await expect(subtitleTrack!.getDisposition()).resolves.toMatchObject({
    forced: true,
    hearingImpaired: true,
  });
});

test('parse content protection when cenc namespaces are omitted', async () => {
  using input = createAssetInput('missing-cenc-namespace.mpd', DASH_FORMATS);

  const primaryVideoTrack = await input.getPrimaryVideoTrack();
  expect(primaryVideoTrack).not.toBeNull();

  const firstSegment = (await primaryVideoTrack!.getSegments())[0];
  expect(firstSegment?.encryption?.method).toBe('cenc');
  expect(firstSegment?.encryption?.drm.widevine?.keyId).toBe(
    '11111111-2222-3333-4444-555555555555',
  );
  expect(firstSegment?.encryption?.drm.widevine?.pssh).toBe('missing-namespace-pssh');
});
