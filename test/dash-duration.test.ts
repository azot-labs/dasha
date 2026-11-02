import { expect, test } from 'vitest';
import { UrlSource } from 'mediabunny';
import { DASH_FORMATS, Input } from '../src';
import { normalizeDashDuration, parseDashDuration } from '../src/dash/dash-misc';

test('round overprecise fractional seconds down to nanoseconds', () => {
  expect(normalizeDashDuration('PT3444.3154296875S')).toBe('PT3444.315429688S');
  expect(normalizeDashDuration('PT0.99999999999S')).toBe('PT1.000000000S');
  expect(normalizeDashDuration('PT60S')).toBe('PT60S');
});

test('leave durations Temporal already accepts untouched', () => {
  expect(normalizeDashDuration('PT12S')).toBe('PT12S');
  expect(normalizeDashDuration('PT2H4M9.600S')).toBe('PT2H4M9.600S');
  expect(normalizeDashDuration('PT0H12M14.123456789S')).toBe('PT0H12M14.123456789S');
  expect(normalizeDashDuration('PT1M')).toBe('PT1M');
});

test('parse overprecise durations to seconds', () => {
  expect(parseDashDuration('PT3444.3154296875S').total('seconds')).toBeCloseTo(3444.315429688, 9);
  expect(parseDashDuration('PT12S').total('seconds')).toBe(12);
});

test('parse a manifest with overprecise mediaPresentationDuration', async () => {
  const manifestText = `<?xml version="1.0" encoding="UTF-8"?>
<MPD
  xmlns="urn:mpeg:dash:schema:mpd:2011"
  type="static"
  mediaPresentationDuration="PT3444.3154296875S"
  minBufferTime="PT2S"
>
  <Period id="main">
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
      <Representation id="video-480p" bandwidth="1000000" width="854" height="480">
        <SegmentTemplate
          timescale="1"
          duration="4"
          initialization="video/init-$RepresentationID$.mp4"
          media="video/chunk-$RepresentationID$-$Number$.m4s"
          startNumber="1"
        />
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

  using input = new Input({
    source: new UrlSource('https://example.com/video.mpd', {
      fetchFn: async () => new Response(manifestText),
    }),
    formats: DASH_FORMATS,
  });

  const videoTracks = await input.getVideoTracks();
  expect(videoTracks).toHaveLength(1);
  const segments = await videoTracks[0]!.getSegments();
  expect(segments).toHaveLength(Math.ceil(3444.315429688 / 4));
});

test.each([
  { offset: 0, gap: 0 },
  { offset: 3600, gap: 0 },
  { offset: 3600, gap: 5 },
])('report the DASH end timestamp with offset $offset and gap $gap', async ({ offset, gap }) => {
  // Kinopoisk's 1:41:21.58 presentation starts at a one-hour timestamp.
  const manifestText = `
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1H41M21.580S">
  <Period>
    <AdaptationSet mimeType="video/mp4" codecs="avc1.640028">
      <Representation id="video" bandwidth="9335000" width="1920" height="804">
        <SegmentTemplate timescale="1000" media="segment-$Number$.m4s" presentationTimeOffset="${offset * 1000}">
          <SegmentTimeline>
            <S t="${offset * 1000}" d="4000" r="1519"/>
            <S t="${(offset + gap) * 1000 + 6080000}" d="1580"/>
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  using input = new Input({
    source: new UrlSource('https://example.com/video.mpd', {
      fetchFn: async (url) => {
        expect(String(url)).toBe('https://example.com/video.mpd');
        return new Response(manifestText);
      },
    }),
    formats: DASH_FORMATS,
  });
  const tracks = await input.getVideoTracks();
  expect(tracks).toHaveLength(1);
  expect(await tracks[0]!.getDurationFromMetadata()).toBeCloseTo(offset + gap + 6081.58);
});
