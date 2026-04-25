import { expect, test } from 'vitest';
import { DASH_FORMATS } from '../src';
import { createAssetInput } from './utils';

test('parse audio-only SegmentBase manifest', async () => {
  using input = createAssetInput('audio-only-segment-base.mpd', DASH_FORMATS);

  const videoTracks = await input.getVideoTracks();
  const audioTracks = await input.getAudioTracks();
  const primaryAudioTrack = await input.getPrimaryAudioTrack();

  expect(videoTracks).toHaveLength(0);
  expect(audioTracks).toHaveLength(2);
  expect(await input.getPrimaryVideoTrack()).toBeNull();
  expect(primaryAudioTrack).not.toBeNull();
  expect(await primaryAudioTrack!.getLanguageCode()).toBe('en');
  expect(await primaryAudioTrack!.getNumberOfChannels()).toBe(2);
  expect(await primaryAudioTrack!.getDurationFromMetadata()).toBe(60);

  const segments = await primaryAudioTrack!.getSegments();
  expect(segments).toHaveLength(1);
  expect(segments[0]?.location.path).toBe('http://example.com/audio_en_2c_128k_aac.mp4');
  expect(segments[0]?.duration).toBe(60);
  expect(segments[0]?.initSegment?.location.path).toBe(
    'http://example.com/audio_en_2c_128k_aac.mp4',
  );
  expect(segments[0]?.initSegment?.location.offset).toBe(0);
  expect(segments[0]?.initSegment?.location.length).toBe(786);
});

test('parse SegmentList manifest', async () => {
  using input = createAssetInput('basic-segment-list.mpd', DASH_FORMATS);

  const targetTrack = (
    await input.getVideoTracks({
      filter: async (track) =>
        (await track.getDisplayHeight()) === 270 && (await track.getBitrate()) === 449000,
    })
  )[0];

  expect(targetTrack).toBeDefined();

  const segments = await targetTrack!.getSegments();
  expect(segments).toHaveLength(10);
  expect(segments.every((segment) => segment.duration === 1)).toBe(true);
  expect(segments[0]?.sequenceNumber).toBe(0);
  expect(segments[9]?.sequenceNumber).toBe(9);
  expect(segments[0]?.initSegment).toBeNull();
  expect(segments[0]?.location.path).toBe('https://www.example.com/low/segment-1.ts');
  expect(segments[9]?.location.path).toBe('https://www.example.com/low/segment-10.ts');
});

test('infer subtitle codecs from text manifests', async () => {
  using input = createAssetInput('subtitle-codecs.mpd', DASH_FORMATS);

  const subtitleTracks = (await input.getTracks()).filter((track) => track.type === 'subtitle');
  expect(subtitleTracks).toHaveLength(2);

  const subtitleEntries = await Promise.all(
    subtitleTracks.map(async (track) => ({
      track,
      language: await track.getLanguageCode(),
      codec: await track.getCodec(),
      codecString: await track.getCodecParameterString(),
    })),
  );
  const englishTrack = subtitleEntries.find((entry) => entry.language === 'en');
  const spanishTrack = subtitleEntries.find((entry) => entry.language === 'es');

  expect(englishTrack).toBeDefined();
  expect(englishTrack?.codec).toBe('stpp');
  expect(englishTrack?.codecString).toBe('stpp.ttml.im1t');

  expect(spanishTrack).toBeDefined();
  expect(spanishTrack?.codec).toBe('vtt');
  expect(spanishTrack?.codecString).toBe('vtt');

  const englishSegments = await englishTrack!.track.getSegments();
  const spanishSegments = await spanishTrack!.track.getSegments();
  expect(englishSegments[0]?.location.path).toBe('https://example.com/en.dash');
  expect(spanishSegments[0]?.location.path).toBe('https://example.com/es.vtt');
});

test('parse SegmentTemplate start numbers and padding', async () => {
  using input = createAssetInput('segment-template-start-number.mpd', DASH_FORMATS);

  const primaryVideoTrack = await input.getPrimaryVideoTrack();
  expect(primaryVideoTrack).not.toBeNull();

  const segments = await primaryVideoTrack!.getSegments();
  expect(segments).toHaveLength(3);
  expect(segments[0]?.sequenceNumber).toBe(0);
  expect(segments[1]?.sequenceNumber).toBe(1);
  expect(segments[2]?.sequenceNumber).toBe(2);
  expect(segments[0]?.initSegment?.location.path).toBe(
    'https://example.com/root/init-video-main.mp4',
  );
  expect(segments[0]?.location.path).toBe('https://example.com/root/segment-video-main-010.m4s');
  expect(segments[1]?.location.path).toBe('https://example.com/root/segment-video-main-011.m4s');
  expect(segments[2]?.location.path).toBe('https://example.com/root/segment-video-main-012.m4s');
});

test('parse SegmentList timelines with ranged media segments', async () => {
  using input = createAssetInput('segment-list-timeline.mpd', DASH_FORMATS);

  const primaryVideoTrack = await input.getPrimaryVideoTrack();
  expect(primaryVideoTrack).not.toBeNull();

  const segments = await primaryVideoTrack!.getSegments();
  expect(segments).toHaveLength(3);
  expect(segments.map((segment) => segment.duration)).toEqual([10, 5, 8]);
  expect(segments.map((segment) => segment.timestamp)).toEqual([50, 60, 65]);
  expect(segments[0]?.initSegment?.location.path).toBe('https://www.example.com/high/video.mp4');
  expect(segments[0]?.initSegment?.location.offset).toBe(0);
  expect(segments[0]?.initSegment?.location.length).toBe(100);
  expect(segments[0]?.location.path).toBe('https://www.example.com/high/segment-1.ts');
  expect(segments[0]?.location.offset).toBe(100);
  expect(segments[0]?.location.length).toBe(100);
  expect(segments[2]?.location.path).toBe('https://www.example.com/high/segment-3.ts');
  expect(segments[2]?.location.offset).toBe(250);
  expect(segments[2]?.location.length).toBe(80);
});

test('expand SegmentTemplate negative repeats up to the period duration', async () => {
  using input = createAssetInput('segment-template-negative-repeat.mpd', DASH_FORMATS);

  const primaryVideoTrack = await input.getPrimaryVideoTrack();
  expect(primaryVideoTrack).not.toBeNull();

  const segments = await primaryVideoTrack!.getSegments();
  expect(segments).toHaveLength(3);
  expect(segments.map((segment) => segment.duration)).toEqual([2, 2, 2]);
  expect(segments.map((segment) => segment.timestamp)).toEqual([0, 2, 4]);
  expect(segments[0]?.initSegment?.location.path).toBe('https://example.com/repeat/init.mp4');
  expect(segments[0]?.location.path).toBe('https://example.com/repeat/segment-0.m4s');
  expect(segments[1]?.location.path).toBe('https://example.com/repeat/segment-2.m4s');
  expect(segments[2]?.location.path).toBe('https://example.com/repeat/segment-4.m4s');
});
