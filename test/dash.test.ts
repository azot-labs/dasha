import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BufferSource, CustomPathedSource, InputFormat } from 'mediabunny';
import { expect, test, vi } from 'vitest';
import { DASH, DASH_FORMATS, Input, UrlSource, desc, isInput } from '../src';

test('parse dash with the mediabunny-like input API', async () => {
  expect(DASH).toBeInstanceOf(InputFormat);

  const manifestPath = path.resolve('test/fixtures/sample.mpd');
  const manifestUrl = pathToFileURL(manifestPath).toString();

  using input = new Input({
    source: new UrlSource(manifestUrl),
    formats: DASH_FORMATS,
  });

  expect(isInput(input)).toBe(true);
  expect(input instanceof Input).toBe(true);
  expect(await input.getFormat()).toBe(DASH);

  const videoTracks = await input.getVideoTracks({
    sortBy: async (track) => [desc(await track.getDisplayHeight()), desc(await track.getBitrate())],
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

test('detects extensionless dash manifests through source fetchFn', async () => {
  const manifestPath = path.resolve('test/fixtures/sample.mpd');
  const manifestText = await readFile(manifestPath, 'utf8');
  const fetchFn = vi.fn(async () => {
    return new Response(manifestText, {
      headers: {
        'content-type': 'application/dash+xml',
      },
    });
  });

  using input = new Input({
    source: new UrlSource('https://example.com/video?id=123', { fetchFn }),
    formats: DASH_FORMATS,
  });

  expect(await input.getFormat()).toBe(DASH);
  expect(fetchFn).toHaveBeenCalled();
});

test('getSegments returns cached dash segments unless explicitly refreshed', async () => {
  const manifestPath = path.resolve('test/fixtures/sample.mpd');
  const manifestUrl = pathToFileURL(manifestPath).toString();

  using input = new Input({
    source: new UrlSource(manifestUrl),
    formats: DASH_FORMATS,
  });

  const videoTracks = await input.getVideoTracks({
    sortBy: async (track) => [desc(await track.getDisplayHeight())],
  });
  const track = videoTracks[0];
  const initialSegments = await track.getSegments();
  const segmentedInput = track.getSegmentedInput();
  const runUpdateSegments = vi.spyOn(segmentedInput, 'runUpdateSegments');

  const cachedSegments = await track.getSegments();
  expect(cachedSegments).toBe(initialSegments);
  expect(runUpdateSegments).not.toHaveBeenCalled();

  const refreshedSegments = await track.refreshSegments();
  expect(refreshedSegments).toBe(segmentedInput.segments);
  expect(runUpdateSegments).toHaveBeenCalledTimes(1);
});

test('exports DASH segment paths resolved through CustomPathedSource', async () => {
  const manifestPath = path.resolve('test/fixtures/sample.mpd');
  const manifestText = await readFile(manifestPath, 'utf8');
  const manifestUrl = new URL('https://example.com/watch.mpd?fromCache=1');

  using input = new Input({
    source: new CustomPathedSource(manifestUrl.href, ({ path, isRoot }) => {
      if (isRoot) {
        return new UrlSource(path, {
          fetchFn: async () =>
            new Response(manifestText, {
              headers: {
                'content-type': 'application/dash+xml',
              },
            }),
        });
      }

      const resolvedUrl = new URL(path, manifestUrl);
      resolvedUrl.searchParams.set('fromCache', manifestUrl.searchParams.get('fromCache')!);
      return new UrlSource(resolvedUrl.href);
    }),
    formats: DASH_FORMATS,
  });

  const videoTracks = await input.getVideoTracks({
    sortBy: async (track) => [desc(await track.getDisplayHeight())],
  });
  const segments = await videoTracks[0]!.getSegments();

  expect(segments[0]!.location.path).toBe(
    'https://example.com/video/chunk-video-720p-1.m4s?fromCache=1',
  );
  expect(segments[0]!.location.sourcePath).toBe('https://example.com/video/chunk-video-720p-1.m4s');
  expect(segments[0]!.initSegment!.location.path).toBe(
    'https://example.com/video/init-video-720p.mp4?fromCache=1',
  );
});

test('requires exported DASH segment paths to resolve to pathed sources', async () => {
  const manifestPath = path.resolve('test/fixtures/sample.mpd');
  const manifestText = await readFile(manifestPath, 'utf8');
  const manifestUrl = 'https://example.com/watch.mpd';

  using input = new Input({
    source: new CustomPathedSource(manifestUrl, ({ path, isRoot }) => {
      if (isRoot) {
        return new UrlSource(path, {
          fetchFn: async () =>
            new Response(manifestText, {
              headers: {
                'content-type': 'application/dash+xml',
              },
            }),
        });
      }

      return new BufferSource(new Uint8Array());
    }),
    formats: DASH_FORMATS,
  });

  const videoTracks = await input.getVideoTracks();
  await expect(videoTracks[0]!.getSegments()).rejects.toThrow(
    'DASH segment requests must resolve to a pathed source.',
  );
});
