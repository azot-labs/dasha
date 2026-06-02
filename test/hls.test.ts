import { createServer } from 'node:http';
import { expect, test } from 'vitest';
import { desc, HLS_FORMATS, Input, UrlSource, isInput } from '../src';
import { CustomPathedSource } from 'mediabunny';

test('parse hls with sample aes', { timeout: 15_000 }, async () => {
  const input = new Input({
    source: new UrlSource(
      'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/hls.m3u8',
      { requestInit: { headers: { Referer: 'https://bitmovin.com/' } } },
    ),
    formats: HLS_FORMATS,
  });

  expect(isInput(input)).toBe(true);

  const videoTracks = await input.getVideoTracks({
    sortBy: async (track) => [
      desc(await track.getDisplayHeight()),
      // Tracks with matching resolution are sorted by bitrate
      desc(await track.getBitrate()),
    ],
    // Filter out #EXT-X-I-FRAME-STREAM-INF tracks
    filter: async (track) => !(await track.hasOnlyKeyPackets()),
  });

  const bestVideoTrack = videoTracks[0];

  const segments = await bestVideoTrack.getSegments();

  expect(segments.length).toBe(15);
  expect(await bestVideoTrack.getDisplayHeight()).toBe(576);
  expect(await bestVideoTrack.getBitrate()).toBe(8065760);

  const firstSegment = segments[0];
  expect(firstSegment.location.path).toBe(
    'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/v-0576p-1400k-libx264-s1.mp4',
  );

  const initSegment = segments[0].initSegment;
  expect(initSegment?.location.path).toBe(
    'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/v-0576p-1400k-libx264-init.mp4',
  );

  const thirdSegment = segments[2];
  expect(thirdSegment.location.path).toBe(
    'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/v-0576p-1400k-libx264-s3.mp4',
  );
  expect(thirdSegment.encryption?.method).toBe('SAMPLE-AES-CTR');
});

test(
  'parse direct hls media playlist segment urls through getSegments()',
  { timeout: 15_000 },
  async () => {
    const input = new Input({
      source: new UrlSource(
        'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/playlist_v-0576p-1400k-libx264.mp4.m3u8',
      ),
      formats: HLS_FORMATS,
    });

    const videoTrack = await input.getPrimaryVideoTrack();
    const segments = await videoTrack!.getSegments();

    expect(segments).toHaveLength(15);
    expect(segments[0]?.location.path).toBe(
      'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/v-0576p-1400k-libx264-s1.mp4',
    );
    expect(segments[0]?.initSegment?.location.path).toBe(
      'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/v-0576p-1400k-libx264-init.mp4',
    );
  },
);

test('exports HLS segment paths resolved through CustomPathedSource', async () => {
  const masterPlaylist = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="avc1.640028,mp4a.40.2"',
    'media.m3u8',
  ].join('\n');
  const mediaPlaylist = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4,',
    'segment-1.ts',
    '#EXTINF:4,',
    'segment-2.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');

  const server = createServer((request, response) => {
    if (request.url?.startsWith('/hls/master.m3u8')) {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end(masterPlaylist);
      return;
    }
    if (request.url?.startsWith('/hls/media.m3u8')) {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end(mediaPlaylist);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start test server');
  }

  const origin = `http://127.0.0.1:${address.port}`;
  const masterUrl = new URL(`${origin}/hls/master.m3u8?Policy=signed`);

  using input = new Input({
    source: new CustomPathedSource(masterUrl.href, ({ path, isRoot }) => {
      if (isRoot) {
        return new UrlSource(path);
      }

      const resolvedUrl = new URL(path, masterUrl);
      resolvedUrl.searchParams.set('Policy', masterUrl.searchParams.get('Policy')!);
      return new UrlSource(resolvedUrl.href);
    }),
    formats: HLS_FORMATS,
  });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    const segments = await videoTrack!.getSegments();

    expect(segments).toHaveLength(2);
    expect(segments[0]?.location.path).toBe(`${origin}/hls/segment-1.ts?Policy=signed`);
    expect(segments[1]?.location.path).toBe(`${origin}/hls/segment-2.ts?Policy=signed`);
    expect(segments[0]?.initSegment?.location.path).toBe(`${origin}/hls/init.mp4?Policy=signed`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
