import { expect, test } from 'vitest';
import { DASH, DASH_FORMATS, getSegments } from '../dasha';
import { createAssetInput, loadAsset } from './utils';

test('parse axinom clear manifest through the Input API', async () => {
  const { originalUrl } = await loadAsset('axinom-1.mpd');
  using input = createAssetInput('axinom-1.mpd', DASH_FORMATS);

  expect(await input.getFormat()).toBe(DASH);
  expect(await input.canRead()).toBe(true);

  const tracks = await input.getTracks();
  expect(tracks).toHaveLength(23);
  expect(tracks.filter((track) => track.type === 'subtitle')).toHaveLength(10);

  const targetTrack = (
    await input.getVideoTracks({
      filter: async (track) =>
        (await track.getDisplayHeight()) === 288 && (await track.getBitrate()) === 386437,
    })
  )[0];

  expect(targetTrack).toBeDefined();
  expect(await targetTrack!.getDurationFromMetadata()).toBe(736);

  const segments = await getSegments(targetTrack!);
  expect(segments).toHaveLength(184);
  expect(segments[0]?.initSegment?.location.path).toBe(new URL('1/init.mp4', originalUrl!).toString());
  expect(segments[0]?.location.path).toBe(new URL('1/0001.m4s', originalUrl!).toString());
});

test('parse axinom multi-drm manifest through the Input API', async () => {
  const { originalUrl } = await loadAsset('axinom-2.mpd');
  using input = createAssetInput('axinom-2.mpd', DASH_FORMATS);

  const tracks = await input.getTracks();
  expect(tracks).toHaveLength(23);

  const firstSubtitleTrack = tracks.find((track) => track.type === 'subtitle');
  expect(await firstSubtitleTrack?.getCodec()).toBe('wvtt');
  const subtitleLanguages = await Promise.all(
    tracks
      .filter((track) => track.type === 'subtitle')
      .map((track) => track.getLanguageCode()),
  );
  expect(subtitleLanguages).toContain('ru');

  const firstVideoTrack = await input.getPrimaryVideoTrack();
  const firstVideoSegment = (await getSegments(firstVideoTrack!))[0];
  expect(firstVideoSegment?.location.path.startsWith(new URL('.', originalUrl!).toString())).toBe(true);
  expect(firstVideoSegment?.location.path.endsWith('/0001.m4s')).toBe(true);
  expect(firstVideoSegment?.encryption?.method).toBe('cenc');
});
