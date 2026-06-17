import { expect, test } from 'vitest';
import { ALL_FORMATS, DASH_FORMATS, Input, UrlSource } from '../src';
import { assetFileUrl, createAssetInput } from './utils';

test('addAudioTracks imports audio tracks from another readable source', async () => {
  using input = createAssetInput('bitmovin.mpd', DASH_FORMATS);

  const originalAudioTracks = await input.getAudioTracks();
  const audioSource = new UrlSource(assetFileUrl('audio-only-segment-base.mpd'));
  const addedTracks = await input.addAudioTracks(audioSource);

  expect(addedTracks).toHaveLength(2);
  expect(addedTracks[0]?.input).toBe(input);
  expect(addedTracks[0]?.source).toBe(audioSource);
  expect(await addedTracks[0]?.getLanguageCode()).toBe('en');
  expect(await addedTracks[1]?.getLanguageCode()).toBe('es');
  expect(await addedTracks[0]?.getCodec()).toBe('aac');
  expect(await addedTracks[0]?.getNumberOfChannels()).toBe(2);
  expect(await addedTracks[0]?.getDurationFromMetadata()).toBe(60);

  const audioTracks = await input.getAudioTracks();
  expect(audioTracks).toHaveLength(originalAudioTracks.length + 2);
  expect(audioTracks).toContain(addedTracks[0]);
  expect(audioTracks).toContain(addedTracks[1]);

  const segments = await addedTracks[0]!.getSegments();
  expect(segments).toHaveLength(1);
  expect(segments[0]?.location.path).toBe('http://example.com/audio_en_2c_128k_aac.mp4');
  expect(segments[0]?.initSegment?.location.path).toBe(
    'http://example.com/audio_en_2c_128k_aac.mp4',
  );
});

test('addAudioTracks pairs imported audio with all video tracks by default', async () => {
  using input = createAssetInput('bitmovin.mpd', DASH_FORMATS);

  const videoTracks = await input.getVideoTracks();
  const addedTracks = await input.addAudioTracks(
    new UrlSource(assetFileUrl('audio-only-segment-base.mpd')),
    {
      filter: async (track) => (await track.getLanguageCode()) === 'es',
    },
  );

  expect(addedTracks).toHaveLength(1);
  await expect(addedTracks[0]!.getPairableVideoTracks()).resolves.toEqual(videoTracks);

  for (const videoTrack of videoTracks) {
    await expect(videoTrack.getPairableAudioTracks()).resolves.toContain(addedTracks[0]);
  }
});

test('addAudioTracks does not preserve source pairing masks', async () => {
  using input = createAssetInput('audio-only-segment-base.mpd', DASH_FORMATS);

  const addedTracks = await input.addAudioTracks(new UrlSource(assetFileUrl('bitmovin.mpd')), {
    pairWith: false,
  });

  expect(addedTracks.length).toBeGreaterThan(0);
  await expect(addedTracks[0]!.getPairableVideoTracks()).resolves.toEqual([]);
});

test(
  'addAudioTracks imports segment access from direct hls media playlists',
  { timeout: 15_000 },
  async () => {
    using input = new Input({
      source: new UrlSource(
        'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/playlist_v-0576p-1400k-libx264.mp4.m3u8',
      ),
      formats: ALL_FORMATS,
    });

    const addedTracks = await input.addAudioTracks(
      new UrlSource(
        'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/playlist_a-eng-0128k-aac-2c.mp4.m3u8',
      ),
    );

    expect(addedTracks).toHaveLength(1);

    const videoTrack = await input.getPrimaryVideoTrack();
    const videoSegments = await videoTrack!.getSegments();
    const audioSegments = await addedTracks[0]!.getSegments();

    expect(videoSegments).toHaveLength(15);
    expect(videoSegments[0]?.location.path).toBe(
      'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/v-0576p-1400k-libx264-s1.mp4',
    );
    expect(audioSegments).toHaveLength(15);
    expect(audioSegments[0]?.location.path).toBe(
      'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/a-eng-0128k-aac-2c-s1.mp4',
    );
    expect(audioSegments[0]?.initSegment?.location.path).toBe(
      'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/a-eng-0128k-aac-2c-init.mp4',
    );
  },
);
