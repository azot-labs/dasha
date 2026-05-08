import { expect, test } from 'vitest';
import { FilePathSource, HLS_FORMATS, Input } from '../src';
import { assetFileUrl, assetPath } from './utils';

const createAppleHlsInput = () =>
  new Input({
    source: new FilePathSource(assetPath('apple-hls.m3u8')),
    formats: HLS_FORMATS,
  });

const getSubtitleDetails = async () => {
  using input = createAppleHlsInput();

  const subtitleTracks = (await input.getTracks()).filter((track) => track.type === 'subtitle');
  const details = await Promise.all(
    subtitleTracks.map(async (track) => ({
      language: await track.getLanguageCode(),
      codec: await track.getCodec(),
      disposition: await track.getDisposition(),
    })),
  );

  return { subtitleTracks, details };
};

test.fails('parse HLS subtitle track codecs and languages from a master playlist', async () => {
  const { subtitleTracks, details } = await getSubtitleDetails();

  expect(subtitleTracks.length).toBeGreaterThan(0);
  expect(details).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ language: 'en', codec: 'webvtt' }),
      expect.objectContaining({ language: 'es-419', codec: 'webvtt' }),
      expect.objectContaining({ language: 'ja', codec: 'webvtt' }),
    ]),
  );
});

test.fails('map HLS subtitle FORCED and SDH metadata to track dispositions', async () => {
  const { subtitleTracks, details } = await getSubtitleDetails();

  expect(subtitleTracks.length).toBeGreaterThan(0);
  expect(details).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        language: 'es-419',
        disposition: expect.objectContaining({ forced: true }),
      }),
      expect.objectContaining({
        language: 'en',
        disposition: expect.objectContaining({ hearingImpaired: true }),
      }),
    ]),
  );
});

test.fails('parse HLS subtitle segment urls through getSegments()', async () => {
  using input = new Input({
    source: new FilePathSource(assetPath('hls-subtitles-master.m3u8')),
    formats: HLS_FORMATS,
  });

  const subtitleTracks = (await input.getTracks()).filter((track) => track.type === 'subtitle');
  expect(subtitleTracks.length).toBeGreaterThan(0);

  const englishTrack = (
    await Promise.all(
      subtitleTracks.map(async (track) => ({
        track,
        language: await track.getLanguageCode(),
        disposition: await track.getDisposition(),
      })),
    )
  ).find((entry) => entry.language === 'en' && !entry.disposition.forced)?.track;

  const forcedTrack = (
    await Promise.all(
      subtitleTracks.map(async (track) => ({
        track,
        language: await track.getLanguageCode(),
        disposition: await track.getDisposition(),
      })),
    )
  ).find((entry) => entry.language === 'en' && entry.disposition.forced)?.track;

  expect(englishTrack).toBeDefined();
  expect(forcedTrack).toBeDefined();

  const englishSegments = await englishTrack!.getSegments();
  const forcedSegments = await forcedTrack!.getSegments();

  expect(englishSegments).toHaveLength(2);
  expect(forcedSegments).toHaveLength(2);
  expect(englishSegments[0]?.location.path).toBe(assetFileUrl('hls-subtitles-en-0001.vtt'));
  expect(englishSegments[1]?.location.path).toBe(assetFileUrl('hls-subtitles-en-0002.vtt'));
  expect(forcedSegments[0]?.location.path).toBe(
    assetFileUrl('hls-subtitles-en-forced-0001.vtt'),
  );
  expect(forcedSegments[1]?.location.path).toBe(
    assetFileUrl('hls-subtitles-en-forced-0002.vtt'),
  );
});
