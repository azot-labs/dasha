import { expect, test } from 'vitest';
import { FilePathSource, HLS_FORMATS, Input, UrlSource } from '../src';
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

test.each([
  ['variants', '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f"\nvideo.m3u8'],
  ['media tags', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio.m3u8"'],
])('rejects HLS playlists with more than 256 %s', async (_type, entry) => {
  const playlist = `#EXTM3U\n${Array.from({ length: 257 }, () => entry).join('\n')}\n`;
  using input = new Input({
    source: new UrlSource('https://example.com/master.m3u8', {
      fetchFn: async () => new Response(playlist),
    }),
    formats: HLS_FORMATS,
  });

  await expect(input.getTracks()).rejects.toThrow('too many variant streams or media tags');
});
