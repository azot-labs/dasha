import { expect, test } from 'vitest';
import { DASH_FORMATS, FilePathSource, HLS_FORMATS, Input, UrlSource } from '../src';
import { assetFileUrl, assetPath, createAssetInput } from './utils';

test('removeSubtitleTrack excludes manifest and added subtitle tracks', async () => {
  using input = new Input({
    source: new FilePathSource(assetPath('hls-subtitles-master.m3u8')),
    formats: HLS_FORMATS,
  });

  const manifestTrack = (await input.getSubtitleTracks())[0];
  const addedTrack = input.addSubtitleTrack(
    new FilePathSource(assetPath('hls-subtitles-en-0001.srt')),
  );

  expect(manifestTrack).toBeDefined();
  input.removeSubtitleTrack(manifestTrack!);
  input.removeSubtitleTrack(addedTrack);

  const subtitleTracks = await input.getSubtitleTracks();
  const allTracks = await input.getTracks();
  expect(subtitleTracks).not.toContain(manifestTrack);
  expect(subtitleTracks).not.toContain(addedTrack);
  expect(allTracks).not.toContain(manifestTrack);
  expect(allTracks).not.toContain(addedTrack);
});

test('removeAudioTrack excludes manifest and imported audio tracks', async () => {
  using input = createAssetInput('bitmovin.mpd', DASH_FORMATS);

  const manifestTrack = (await input.getAudioTracks())[0];
  const [importedTrack] = await input.addAudioTracks(
    new UrlSource(assetFileUrl('audio-only-segment-base.mpd')),
  );

  expect(manifestTrack).toBeDefined();
  expect(importedTrack).toBeDefined();
  input.removeAudioTrack(manifestTrack!);
  input.removeAudioTrack(importedTrack!);

  const audioTracks = await input.getAudioTracks();
  const allTracks = await input.getTracks();
  expect(audioTracks).not.toContain(manifestTrack);
  expect(audioTracks).not.toContain(importedTrack);
  expect(allTracks).not.toContain(manifestTrack);
  expect(allTracks).not.toContain(importedTrack);
});

test('track removal rejects tracks from another input', async () => {
  using input = createAssetInput('bitmovin.mpd', DASH_FORMATS);
  using otherInput = createAssetInput('audio-only-segment-base.mpd', DASH_FORMATS);

  const otherAudioTrack = (await otherInput.getAudioTracks())[0];
  expect(otherAudioTrack).toBeDefined();

  expect(() => input.removeAudioTrack(otherAudioTrack!)).toThrow(
    'track must belong to the same input instance.',
  );
});
