import { expect, test } from 'vitest';
import { desc, HLS_FORMATS, Input, UrlSource, isInput } from '../dasha';

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
