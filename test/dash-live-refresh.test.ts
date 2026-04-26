import { expect, test } from 'vitest';
import { DASH_FORMATS, Input, UrlSource } from '../src';
import { DashDemuxer } from '../src/dash/dash-demuxer';

const createLiveManifest = (periodId: string, audioGroupId = 'audio-1') => `<?xml version="1.0" encoding="UTF-8"?>
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
