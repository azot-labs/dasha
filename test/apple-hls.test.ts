import { expect, test } from 'vitest';
import { FilePathSource, HLS_FORMATS, Input } from '../dasha';
import { assetPath } from './utils';

test('parse local apple hls master playlist through the Input API', async () => {
  using input = new Input({
    source: new FilePathSource(assetPath('apple-hls.m3u8')),
    formats: HLS_FORMATS,
  });

  const tracks = await input.getTracks();
  expect(tracks.length).toBeGreaterThan(100);
  expect((await input.getVideoTracks()).length).toBeGreaterThan(0);
  expect(await input.getPrimaryVideoTrack()).not.toBeNull();
});
