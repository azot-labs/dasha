import {
  Conversion,
  Input as MediabunnyInput,
  Mp4OutputFormat,
  NullTarget,
  Output,
  UrlSource,
} from 'mediabunny';
import { expect, test } from 'vitest';
import { DASH_FORMATS } from '../src';
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

test('conversion track selection ignores DASH subtitles on plain mediabunny Input', async () => {
  using input = new MediabunnyInput({
    source: new UrlSource(assetFileUrl('axinom-2.mpd')),
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
