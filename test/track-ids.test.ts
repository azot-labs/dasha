import { expect, test } from 'vitest';
import { DASH_FORMATS, FilePathSource, HLS_FORMATS, Input, UrlSource } from '../src';
import { assetFileUrl, assetPath, createAssetInput } from './utils';

test('HLS subtitle IDs follow native tracks and stay stable across track queries', async () => {
  using input = new Input({
    source: new FilePathSource(assetPath('hls-subtitles-master.m3u8')),
    formats: HLS_FORMATS,
  });

  const subtitles = await input.getSubtitleTracks({
    filter: (track) => track.id > 0,
    sortBy: (track) => [-track.id],
  });
  expect(subtitles).toHaveLength(2);

  const tracks = await input.getTracks();
  const ids = tracks.map((track) => track.id);
  expect(ids).toEqual(tracks.map((_, index) => index + 1));
  expect(subtitles.map((track) => track.id)).toEqual(ids.slice(-2).reverse());
  expect((await input.getVideoTracks()).map((track) => track.id)).toEqual(
    tracks.filter((track) => track.type === 'video').map((track) => track.id),
  );
  expect((await input.getAudioTracks()).map((track) => track.id)).toEqual(
    tracks.filter((track) => track.type === 'audio').map((track) => track.id),
  );

  input.removeSubtitleTrack(subtitles[0]);
  expect((await input.getTracks()).map((track) => track.id)).toEqual(
    ids.filter((id) => id !== subtitles[0].id),
  );
});

test('external subtitle IDs are available before reading native tracks', async () => {
  using input = createAssetInput('bitmovin.mpd', DASH_FORMATS);
  const source = new FilePathSource(assetPath('hls-subtitles-en-0001.srt'));
  const first = input.addSubtitleTrack(source);
  const second = input.addSubtitleTrack(source);
  const ids = [first.id, second.id];

  expect(new Set(ids).size).toBe(2);
  const tracks = await input.getTracks();
  expect(new Set(tracks.map((track) => track.id)).size).toBe(tracks.length);
  expect((await input.getSubtitleTracks()).map((track) => track.id)).toEqual(ids);
});

test('imported audio IDs are unique and stay stable across track queries', async () => {
  using input = createAssetInput('bitmovin.mpd', DASH_FORMATS);
  const original = await input.getTracks();
  const originalIds = original.map((track) => track.id);
  const imported = await input.addAudioTracks(
    new UrlSource(assetFileUrl('audio-only-segment-base.mpd')),
  );
  expect(imported).toHaveLength(2);
  const importedIds = imported.map((track) => track.id);

  const tracks = await input.getTracks();
  expect(tracks.map((track) => track.id)).toEqual([...originalIds, ...importedIds]);
  expect(new Set(tracks.map((track) => track.id)).size).toBe(tracks.length);
  expect(original.map((track) => track.id)).toEqual(originalIds);
  expect(await input.getAudioTracks({ filter: (track) => importedIds.includes(track.id) })).toEqual(
    imported,
  );
});

test('merging inputs remaps synthetic IDs and preserves their origin IDs', async () => {
  const first = createAssetInput('bitmovin.mpd', DASH_FORMATS);
  const subtitle = first.addSubtitleTrack(
    new FilePathSource(assetPath('hls-subtitles-en-0001.srt')),
  );
  const second = createAssetInput('multiple-audio-adaptation-sets.mpd', DASH_FORMATS);
  using merged = Input.merge([first, second]);

  const tracks = await merged.getTracks();
  expect(tracks.map((track) => track.id)).toEqual(tracks.map((_, index) => index + 1));
  const [mergedSubtitle] = await merged.getSubtitleTracks();
  expect(mergedSubtitle.origin).toBe(subtitle);
  expect(mergedSubtitle.origin.id).toBe(subtitle.id);
  expect(mergedSubtitle.id).not.toBe(subtitle.id);
});
