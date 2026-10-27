import { expect, test, vi } from 'vitest';
import { DASH_FORMATS, Input, UrlSource } from '../src';
import { DashDemuxer } from '../src/dash/dash-demuxer';

const createLiveManifest = (
  periodId: string,
  audioGroupId = 'audio-1',
) => `<?xml version="1.0" encoding="UTF-8"?>
<MPD
  xmlns="urn:mpeg:dash:schema:mpd:2011"
  type="dynamic"
  availabilityStartTime="2026-01-01T00:00:00Z"
  minimumUpdatePeriod="PT2S"
  minBufferTime="PT1S"
  timeShiftBufferDepth="PT30S">
  <Period id="${periodId}" start="PT0S">
    <AdaptationSet mimeType="video/mp4" contentType="video" segmentAlignment="true">
      <Representation id="video-1" bandwidth="1000000" codecs="avc1.4d401f" width="640" height="360">
        <SegmentTemplate media="video-$Number$.m4s" startNumber="1" timescale="1">
          <SegmentTimeline>
            <S t="0" d="2" r="1" />
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" contentType="audio" segmentAlignment="true">
      <Representation id="${audioGroupId}" bandwidth="128000" codecs="mp4a.40.2">
        <AudioChannelConfiguration
          schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011"
          value="2" />
        <SegmentTemplate media="audio-$Number$.m4s" startNumber="1" timescale="1">
          <SegmentTimeline>
            <S t="0" d="2" r="1" />
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const createDemuxer = () =>
  new DashDemuxer(
    new Input({
      source: new UrlSource('file:///test/live-rollover.mpd'),
      formats: DASH_FORMATS,
    }),
  );

test.each([1, 1000])('use integer live segment numbers with timescale %i', async (timescale) => {
  using now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T00:01:40.376Z'));
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"
  availabilityStartTime="2026-01-01T00:00:00Z" timeShiftBufferDepth="PT6S">
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="video-1" bandwidth="1000000" codecs="avc1.4d401f" width="640" height="360">
        <SegmentTemplate media="video-$Number$-$Number%03d$.m4s"
          startNumber="10" timescale="${timescale}" duration="${2 * timescale}" />
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  using input = new Input({
    source: new UrlSource('https://example.com/live.mpd', {
      fetchFn: async () => new Response(manifest),
    }),
    formats: DASH_FORMATS,
  });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('Missing DASH video track.');

  const segments = await track.getSegments();
  expect(segments.map((segment) => segment.sequenceNumber)).toEqual([57, 58, 59]);
  expect(segments.map((segment) => segment.location.path)).toEqual([
    'https://example.com/video-57-057.m4s',
    'https://example.com/video-58-058.m4s',
    'https://example.com/video-59-059.m4s',
  ]);

  const segmentedInput = track.getSegmentedInput();
  now.mockReturnValue(Date.parse('2026-01-01T00:01:41.876Z'));
  await segmentedInput.updateSegments();
  expect(segmentedInput.segments.map((segment) => segment.location.path)).toEqual(
    segments.map((segment) => segment.location.path),
  );

  now.mockReturnValue(Date.parse('2026-01-01T00:01:42.376Z'));
  await segmentedInput.updateSegments();
  expect(segmentedInput.segments.map((segment) => segment.sequenceNumber)).toEqual([58, 59, 60]);
  expect(segmentedInput.segments[0]?.location.path).toBe('https://example.com/video-58-058.m4s');
});

test.each(['static', 'dynamic'])(
  'check %s DASH liveness without fetching the manifest again',
  async (type) => {
    const manifest = createLiveManifest('period-a').replace('type="dynamic"', `type="${type}"`);
    const fetchFn = vi.fn(async () => new Response(manifest));
    using input = new Input({
      source: new UrlSource('https://example.com/manifest.mpd', { fetchFn }),
      formats: DASH_FORMATS,
    });
    const tracks = await input.getTracks();
    expect(tracks).toHaveLength(2);
    const initialRequestCount = fetchFn.mock.calls.length;
    expect(initialRequestCount).toBeGreaterThan(0);

    for (let index = 0; index < 3; index++) {
      for (const track of tracks) {
        expect(await track.isLive()).toBe(type === 'dynamic');
        expect(await track.getLiveRefreshInterval()).toBe(type === 'dynamic' ? 2 : null);
      }
    }

    expect(fetchFn).toHaveBeenCalledTimes(initialRequestCount);
  },
);

test.each([
  { minimumUpdatePeriod: 'PT2S', expected: 2 },
  { minimumUpdatePeriod: 'PT2.1S', expected: 2.1 },
  { minimumUpdatePeriod: 'PT0S', expected: 30 },
  { minimumUpdatePeriod: null, expected: 30 },
])(
  'use a live DASH refresh interval of $expected seconds for $minimumUpdatePeriod',
  async ({ minimumUpdatePeriod, expected }) => {
    const manifest = createLiveManifest('period-a')
      .replace(
        'minimumUpdatePeriod="PT2S"',
        minimumUpdatePeriod === null ? '' : `minimumUpdatePeriod="${minimumUpdatePeriod}"`,
      )
      .replace('timeShiftBufferDepth="PT30S"', 'timeShiftBufferDepth="PT1M"');
    using input = new Input({
      source: new UrlSource('https://example.com/live.mpd', {
        fetchFn: async () => new Response(manifest),
      }),
      formats: DASH_FORMATS,
    });

    const tracks = await input.getTracks();
    for (const track of tracks) {
      expect(await track.getLiveRefreshInterval()).toBe(expected);
    }
  },
);

test('refresh live DASH segments after minimumUpdatePeriod', async () => {
  using now = vi.spyOn(performance, 'now').mockReturnValue(0);
  let manifest = createLiveManifest('period-a').replace(
    'timeShiftBufferDepth="PT30S"',
    'timeShiftBufferDepth="PT1M"',
  );
  const fetchFn = vi.fn(async () => new Response(manifest));
  using input = new Input({
    source: new UrlSource('https://example.com/live.mpd', { fetchFn }),
    formats: DASH_FORMATS,
  });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('Missing DASH video track.');

  const initialSegments = await track.getSegments();
  expect(initialSegments.map((segment) => segment.timestamp)).toEqual([0, 2]);

  manifest = manifest
    .replace('<S t="0" d="2" r="1" />', '<S t="0" d="2" r="2" />')
    .replace('minimumUpdatePeriod="PT2S"', 'minimumUpdatePeriod="PT1S"');
  now.mockReturnValue(2000);
  expect(track.getSegmentedInput().getRemainingWaitTimeMs()).toBe(0);
  const requestCount = fetchFn.mock.calls.length;
  const refreshedSegments = await track.refreshSegments();

  expect(fetchFn).toHaveBeenCalledTimes(requestCount + 1);
  expect(refreshedSegments.map((segment) => segment.timestamp)).toEqual([0, 2, 4]);
  expect(await track.getLiveRefreshInterval()).toBe(1);
  expect(track.getSegmentedInput().getRemainingWaitTimeMs()).toBe(1000);
});

test('match refreshed live tracks across period rollover without init segments', () => {
  const demuxer = createDemuxer();
  const currentTracks = demuxer.extractTracks(createLiveManifest('period-a'));
  const nextTracks = demuxer.extractTracks(createLiveManifest('period-b'));

  const currentAudioTrack = currentTracks.find((track) => track.type === 'audio');
  expect(currentAudioTrack).toBeDefined();

  const matchingTrack = demuxer.findMatchingTrack(nextTracks, currentAudioTrack!);
  expect(matchingTrack?.type).toBe('audio');
  expect(matchingTrack?.groupId).toBe(currentAudioTrack?.groupId);
  expect(matchingTrack?.periodId).toBe('period-b');
});

test('do not match unrelated tracks when init segments are absent', () => {
  const demuxer = createDemuxer();
  const currentTracks = demuxer.extractTracks(createLiveManifest('period-a'));
  const nextTracks = demuxer.extractTracks(createLiveManifest('period-b', 'audio-2'));

  const currentAudioTrack = currentTracks.find((track) => track.type === 'audio');
  expect(currentAudioTrack).toBeDefined();

  expect(demuxer.findMatchingTrack(nextTracks, currentAudioTrack!)).toBeUndefined();
});

test('refresh DASH manifests through source fetchFn', async () => {
  const manifests = [
    createLiveManifest('period-a'),
    createLiveManifest('period-a'),
    createLiveManifest('period-b'),
  ];
  const fetchFn = vi.fn(async () => {
    const manifest = manifests.shift();
    if (!manifest) {
      throw new Error('Unexpected manifest refresh');
    }

    return new Response(manifest, {
      headers: {
        'content-type': 'application/dash+xml',
      },
    });
  });

  using input = new Input({
    source: new UrlSource('https://example.com/live', { fetchFn }),
    formats: DASH_FORMATS,
  });

  const videoTracks = await input.getVideoTracks();
  const segmentedInput = videoTracks[0]!.getSegmentedInput();
  const track = segmentedInput.internalTrack.track;

  expect(track.periodId).toBe('period-a');

  await segmentedInput.demuxer.refreshTracks([track]);

  expect(track.periodId).toBe('period-b');
  expect(fetchFn).toHaveBeenCalledTimes(3);
});
