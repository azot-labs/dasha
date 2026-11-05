import { expect, test } from 'vitest';
import { DASH_FORMATS, FilePathSource, HLS_FORMATS, Input } from '../src';
import { assetPath, createAssetInput } from './utils';

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

test.each([
  ['DASH', 'bitmovin.mpd', DASH_FORMATS],
  ['HLS', 'hls-subtitles-master.m3u8', HLS_FORMATS],
])('setName overrides native %s track names for future queries', async (_, asset, formats) => {
  using input =
    formats === HLS_FORMATS
      ? new Input({ source: new FilePathSource(assetPath(asset)), formats })
      : createAssetInput(asset, formats);
  const audioTrack = (await input.getAudioTracks())[0]!;
  const originalLanguage = await audioTrack.getLanguageCode();

  audioTrack.setName('French dub');

  expect(await audioTrack.getName()).toBe('French dub');
  expect(audioTrack.name).toBe('French dub');
  expect(await audioTrack.getLanguageCode()).toBe(originalLanguage);
  expect(
    await input.getAudioTracks({
      filter: async (track) => (await track.getName()) === 'French dub',
    }),
  ).toEqual([audioTrack]);

  audioTrack.setLanguageCode('fr');
  audioTrack.setName('French commentary');
  expect(await audioTrack.getLanguageCode()).toBe('fr');
  expect(await audioTrack.getName()).toBe('French commentary');

  audioTrack.setName(null);
  expect(await audioTrack.getName()).toBeNull();
  expect(audioTrack.name).toBeNull();
  expect(await audioTrack.getLanguageCode()).toBe('fr');
});
