import { expect, test } from 'vitest';
import { DASH_FORMATS } from '../src';
import { createAssetInput } from './utils';

test('setLanguageCode overrides native track language for future queries', async () => {
  using input = createAssetInput('bitmovin.mpd', DASH_FORMATS);

  const audioTrack = (await input.getAudioTracks())[0];
  expect(audioTrack).toBeDefined();

  audioTrack!.setLanguageCode('fr');

  expect(await audioTrack!.getLanguageCode()).toBe('fr');
  expect(audioTrack!.languageCode).toBe('fr');

  const frenchTracks = await input.getAudioTracks({
    filter: async (track) => (await track.getLanguageCode()) === 'fr',
  });

  expect(frenchTracks).toHaveLength(1);
  expect(frenchTracks[0]).toBe(audioTrack);
});
