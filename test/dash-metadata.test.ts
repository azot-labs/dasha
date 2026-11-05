import { expect, test } from 'vitest';
import { DASH_FORMATS, Input, UrlSource } from '../src';
import { createAssetInput, loadAssetSync } from './utils';

test.each([
  ['adaptation set content type', 'contentType="image"', ''],
  ['adaptation set MIME type', 'mimeType="image/jpeg"', ''],
  ['representation content type', '', 'contentType="image"'],
  ['representation MIME type', '', 'mimeType="image/jpeg"'],
])(
  'ignores DASH thumbnails identified by %s',
  async (_name, adaptationAttrs, representationAttrs) => {
    const manifest = loadAssetSync('dash-ntv-thumbnails.mpd')
      .replace('mimeType="image/jpeg" contentType="image"', adaptationAttrs)
      .replace('id="thumbnails_160x90"', `id="thumbnails_160x90" ${representationAttrs}`);
    using input = new Input({
      source: new UrlSource('https://example.com/ntv/h264.mpd', {
        fetchFn: async () => new Response(manifest),
      }),
      formats: DASH_FORMATS,
    });

    expect(await input.getTracks()).toHaveLength(5);
    expect(await input.getVideoTracks()).toHaveLength(4);
    expect(await input.getAudioTracks()).toHaveLength(1);
    expect(await input.getSubtitleTracks()).toHaveLength(0);
    expect(await (await input.getPrimaryVideoTrack())?.getDisplayHeight()).toBe(1080);
  },
);

test('preserve dash track metadata across video, audio, and subtitles', async () => {
  using input = createAssetInput('axinom-2.mpd', DASH_FORMATS);

  const videoTracks = await input.getVideoTracks();
  const audioTracks = await input.getAudioTracks();
  const subtitleTracks = (await input.getTracks()).filter((track) => track.type === 'subtitle');

  expect(videoTracks.length).toBeGreaterThan(0);
  expect(audioTracks.length).toBeGreaterThan(0);
  expect(subtitleTracks).toHaveLength(10);
  expect(videoTracks.length + audioTracks.length + subtitleTracks.length).toBe(23);

  const primaryVideoTrack = await input.getPrimaryVideoTrack();
  const primaryAudioTrack = await input.getPrimaryAudioTrack();

  expect(primaryVideoTrack).not.toBeNull();
  expect(primaryAudioTrack).not.toBeNull();

  expect(await primaryVideoTrack!.getCodec()).toBe('avc');
  expect(await primaryVideoTrack!.getCodecParameterString()).toBe('avc1.640033');
  expect(await primaryVideoTrack!.getDisplayHeight()).toBe(1080);
  expect(await primaryVideoTrack!.getBitrate()).toBeGreaterThan(0);

  expect(await primaryAudioTrack!.getCodec()).toBe('aac');
  expect(await primaryAudioTrack!.getCodecParameterString()).toMatch(/^mp4a\.40\./);
  expect(await primaryAudioTrack!.getNumberOfChannels()).toBe(2);
  expect(await primaryAudioTrack!.getLanguageCode()).toBe('en');

  const subtitleLanguages = await Promise.all(
    subtitleTracks.map((track) => track.getLanguageCode()),
  );
  expect(subtitleLanguages).toContain('ru');

  const firstSubtitleTrack = subtitleTracks[0];
  expect(firstSubtitleTrack).toBeDefined();
  expect(await firstSubtitleTrack!.getCodec()).toBe('webvtt');
  expect(await firstSubtitleTrack!.getCodecParameterString()).toBe('wvtt');
});

test('keep dash segment numbering and init segment association stable', async () => {
  using input = createAssetInput('axinom-1.mpd', DASH_FORMATS);

  const targetTrack = (
    await input.getVideoTracks({
      filter: async (track) =>
        (await track.getDisplayHeight()) === 288 && (await track.getBitrate()) === 386437,
    })
  )[0];

  const segments = await targetTrack!.getSegments();
  expect(segments).toHaveLength(184);
  expect(segments[0]?.sequenceNumber).toBe(0);
  expect(segments[1]?.sequenceNumber).toBe(1);
  expect(segments[0]?.firstSegment).toBe(segments[0]);
  expect(segments[1]?.firstSegment).toBe(segments[0]);
  expect(segments[0]?.initSegment?.sequenceNumber).toBe(-1);
});

test('keeps separate DASH audio adaptation sets pairable with video', async () => {
  using input = createAssetInput('multiple-audio-adaptation-sets.mpd', DASH_FORMATS);

  const videoTrack = await input.getPrimaryVideoTrack();
  const audioTracks = await input.getAudioTracks();

  expect(videoTrack).not.toBeNull();
  expect(audioTracks).toHaveLength(3);
  expect(audioTracks.every((track) => track.canBePairedWith(videoTrack!))).toBe(true);

  const audioEntries = await Promise.all(
    audioTracks.map(async (track) => ({
      language: await track.getLanguageCode(),
      name: await track.getName(),
    })),
  );

  expect(audioEntries).toEqual(
    expect.arrayContaining([
      { language: 'rus-x-anistar-dub', name: 'Russian (AniStar dub)' },
      { language: 'jpn', name: 'Japanese' },
      { language: 'rus-x-anilibr-vo', name: 'Russian (AniLibria voice-over)' },
    ]),
  );
});
