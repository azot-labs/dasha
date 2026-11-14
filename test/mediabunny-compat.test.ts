import {
  BufferTarget,
  Conversion,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Input as MediabunnyInput,
  Mp4OutputFormat,
  NullTarget,
  Output,
  UrlSource,
} from 'mediabunny';
import { expect, test } from 'vitest';
import { DASH_FORMATS, preserveSubtitleBackingsOnInput } from '../src';
import { assetFileUrl } from './utils';

test('plain mediabunny Input does not expose DASH subtitles as audio tracks', async () => {
  using input = new MediabunnyInput({
    source: new UrlSource(assetFileUrl('axinom-2.mpd')),
    formats: DASH_FORMATS,
  });

  const audioTracks = await input.getAudioTracks();
  const languages = await Promise.all(audioTracks.map((track) => track.getLanguageCode()));

  expect(audioTracks).toHaveLength(3);
  expect(languages).toEqual(['en', 'en-AU', 'et-ET']);
  expect(languages).not.toContain('ru');
});

test('preserveSubtitleBackingsOnInput opts internal inputs out of subtitle filtering', async () => {
  const subtitleTrack = { type: 'subtitle' };
  const input = Object.assign(Object.create(MediabunnyInput.prototype), {
    _getTrackBackings: async () => [{ getType: () => 'audio' }, { getType: () => 'subtitle' }],
    _wrapBackingAsTrack(backing: { getType(): string }) {
      return backing.getType() === 'subtitle' ? subtitleTrack : { type: backing.getType() };
    },
  }) as MediabunnyInput;

  expect(await input.getTracks()).toEqual([{ type: 'audio' }]);

  preserveSubtitleBackingsOnInput(input);

  expect(await input.getTracks()).toEqual([{ type: 'audio' }, subtitleTrack]);
});

test('conversion track selection ignores DASH subtitles on plain mediabunny Input', async () => {
  const media = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const video = new EncodedVideoPacketSource('vp9');
  const audio = new EncodedAudioPacketSource('opus');
  media.addVideoTrack(video);
  media.addAudioTrack(audio);
  await media.start();
  await video.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 1), {
    decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 640, codedHeight: 360 },
  });
  await audio.add(new EncodedPacket(new Uint8Array([0xf8, 0xff, 0xfe]), 'key', 0, 0.02), {
    decoderConfig: { codec: 'opus', numberOfChannels: 2, sampleRate: 48000 },
  });
  await media.finalize();

  // Conversion.init reads packets, so keep both the manifest and its media local.
  const manifest = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1S">
    <Period duration="PT1S">
      <AdaptationSet contentType="video" mimeType="video/mp4" codecs="vp09.00.10.08">
        <Representation id="video" bandwidth="1000000" width="640" height="360">
          <BaseURL>media.mp4</BaseURL>
        </Representation>
      </AdaptationSet>
      <AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="opus" lang="en">
        <Representation id="audio" bandwidth="64000" audioSamplingRate="48000">
          <BaseURL>media.mp4</BaseURL>
        </Representation>
      </AdaptationSet>
      <AdaptationSet contentType="text" mimeType="text/vtt" lang="ru">
        <Representation id="subtitles" bandwidth="100">
          <BaseURL>subtitles.vtt</BaseURL>
        </Representation>
      </AdaptationSet>
    </Period>
  </MPD>`;
  using input = new MediabunnyInput({
    source: new UrlSource('https://media.test/manifest.mpd', {
      fetchFn: async (url) => {
        if (String(url).endsWith('/manifest.mpd')) return new Response(manifest);
        if (String(url).endsWith('/media.mp4')) return new Response(media.target.buffer!);
        throw new Error(`Unexpected media request: ${url}`);
      },
    }),
    formats: DASH_FORMATS,
  });

  const selectedVideo = await input.getPrimaryVideoTrack();
  const selectedAudio = await input.getPrimaryAudioTrack();

  expect(selectedVideo).not.toBeNull();
  expect(selectedAudio).not.toBeNull();

  const conversion = await Conversion.init({
    input,
    output: new Output({
      format: new Mp4OutputFormat(),
      target: new NullTarget(),
    }),
    tracks: 'all',
    video: async (track) => ({
      discard: track.number !== selectedVideo!.number,
    }),
    audio: async (track) => ({
      discard: track.number !== selectedAudio!.number,
    }),
    showWarnings: false,
  });

  expect(conversion.isValid).toBe(true);
  expect(conversion.utilizedTracks).toHaveLength(2);
});
