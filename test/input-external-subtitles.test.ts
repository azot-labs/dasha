import { expect, test } from 'vitest';
import { DASH_FORMATS, FilePathSource } from '../src';
import { createAssetInput, assetPath, assetFileUrl } from './utils';

test('addSubtitleTrack adds direct subtitle files to the input query API', async () => {
  using input = createAssetInput('bitmovin.mpd', DASH_FORMATS);

  const addedTrack = input.addSubtitleTrack(
    new FilePathSource(assetPath('hls-subtitles-en-0001.srt')),
    {
      languageCode: 'en',
      name: 'English',
      disposition: {
        default: false,
        forced: true,
      },
    },
  );

  expect(await addedTrack.getCodec()).toBe('srt');
  expect(await addedTrack.getLanguageCode()).toBe('en');
  expect(await addedTrack.getName()).toBe('English');
  await expect(addedTrack.getDisposition()).resolves.toMatchObject({
    default: false,
    forced: true,
  });

  const subtitleTracks = await input.getSubtitleTracks({
    filter: async (track) => (await track.getLanguageCode()) === 'en',
  });
  expect(subtitleTracks).toHaveLength(1);
  expect(subtitleTracks[0]).toBe(addedTrack);

  const segments = await addedTrack.getSegments();
  expect(segments).toHaveLength(1);
  expect(segments[0]?.location.path).toBe(assetFileUrl('hls-subtitles-en-0001.srt'));
});

test('addSubtitleTrack can pair external subtitles with selected video tracks', async () => {
  using input = createAssetInput('bitmovin.mpd', DASH_FORMATS);

  const primaryVideoTrack = await input.getPrimaryVideoTrack();
  const primaryAudioTrack = await input.getPrimaryAudioTrack();

  expect(primaryVideoTrack).not.toBeNull();
  expect(primaryAudioTrack).not.toBeNull();

  const addedTrack = input.addSubtitleTrack(
    new FilePathSource(assetPath('hls-subtitles-srt.m3u8')),
    {
      languageCode: 'en',
      pairWith: primaryVideoTrack!,
    },
  );

  expect(await addedTrack.getCodec()).toBe('srt');

  const pairableVideoTracks = await addedTrack.getPairableVideoTracks();
  expect(pairableVideoTracks).toHaveLength(1);
  expect(pairableVideoTracks[0]).toBe(primaryVideoTrack);

  await expect(addedTrack.getPairableAudioTracks()).resolves.toEqual([]);

  const segments = await addedTrack.getSegments();
  expect(segments).toHaveLength(2);
  expect(segments[0]?.location.path).toBe(assetFileUrl('hls-subtitles-en-0001.srt'));
  expect(segments[1]?.location.path).toBe(assetFileUrl('hls-subtitles-en-0002.srt'));
});
