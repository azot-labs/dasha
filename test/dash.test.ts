import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { DASH, DASH_FORMATS, Input, UrlSource, desc, isInput } from '../dasha';

test('parse dash with the mediabunny-like input API', async () => {
  const manifestPath = path.resolve('test/fixtures/sample.mpd');
  const manifestUrl = pathToFileURL(manifestPath).toString();

  const input = new Input({
    source: new UrlSource(manifestUrl),
    formats: DASH_FORMATS,
  });

  expect(isInput(input)).toBe(true);
  expect(input instanceof Input).toBe(true);
  expect(await input.getFormat()).toBe(DASH);

  const videoTracks = await input.getVideoTracks({
    sortBy: async (track) => [
      desc(await track.getDisplayHeight()),
      desc(await track.getBitrate()),
    ],
  });

  const bestVideoTrack = videoTracks[0];
  const segments = await bestVideoTrack.getSegments();

  expect(videoTracks).toHaveLength(2);
  expect(segments).toHaveLength(3);
  expect(await bestVideoTrack.getDisplayHeight()).toBe(720);
  expect(await bestVideoTrack.getBitrate()).toBe(2_000_000);

  const initUrl = new URL('video/init-video-720p.mp4', manifestUrl).toString();
  const firstSegmentUrl = new URL('video/chunk-video-720p-1.m4s', manifestUrl).toString();
  const thirdSegmentUrl = new URL('video/chunk-video-720p-3.m4s', manifestUrl).toString();

  expect(segments[0]?.initSegment?.location.path).toBe(initUrl);
  expect(segments[0]?.location.path).toBe(firstSegmentUrl);
  expect(segments[2]?.location.path).toBe(thirdSegmentUrl);
});
