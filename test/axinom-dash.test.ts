import { expect, test } from 'vitest';
import { StreamExtractor } from '../lib/stream-extractor';
import { MEDIA_TYPES } from '../lib/shared/media-type';
import { ParserConfig } from '../lib/parser-config';
import { load } from './utils';

test('parse axinom mpd from text', async () => {
  const { text, url } = await load('axinom-1.mpd');

  const parseConfig = new ParserConfig();
  const streamExtractor = new StreamExtractor(parseConfig);
  await streamExtractor.loadSourceFromText(text, url);
  const streams = await streamExtractor.extractStreams();

  const videos = streams.filter((stream) => stream.mediaType === MEDIA_TYPES.VIDEO);
  expect(videos.length).toBe(10);
  for (const video of videos) {
    const segmentsCount = video.playlist?.mediaParts[0]?.mediaSegments?.length;
    expect(segmentsCount).toBe(184);
  }
  videos.sort((a, b) => b.bandwidth! - a.bandwidth!);
  const largestVideo = videos.at(0);
  expect(largestVideo?.bandwidth).toBe(2723012);
  expect(largestVideo?.codecs).toBe('avc1.640033');
  const smallestVideo = videos.at(-1);
  expect(smallestVideo?.bandwidth).toBe(386437);
  expect(smallestVideo?.codecs).toBe('avc1.64001f');

  const audios = streams.filter((stream) => stream.mediaType === MEDIA_TYPES.AUDIO);
  expect(audios.length).toBe(3);

  const subtitles = streams.filter((stream) => stream.mediaType === MEDIA_TYPES.SUBTITLES);
  expect(subtitles.length).toBe(10);

  const firstVideoTrack = streams.find((stream) => stream.mediaType === MEDIA_TYPES.VIDEO);
  const firstVideoSegment = firstVideoTrack?.playlist?.mediaParts[0]?.mediaSegments[0];
  expect(firstVideoSegment?.url).toBe(url?.replace('Manifest_1080p.mpd', '1/0001.m4s'));

  const firstSubtitleTrack = streams.find((stream) => stream.mediaType === MEDIA_TYPES.SUBTITLES);
  expect(firstSubtitleTrack?.codecs, 'wvtt');
  expect(firstSubtitleTrack?.language, 'ru');
});

test('parse axinom mpd with drm from text', async () => {
  const { text, url } = await load('axinom-2.mpd');

  const parseConfig = new ParserConfig();
  const streamExtractor = new StreamExtractor(parseConfig);
  await streamExtractor.loadSourceFromText(text, url);
  const streams = await streamExtractor.extractStreams();

  const firstVideoTrack = streams.find((stream) => stream.mediaType === MEDIA_TYPES.VIDEO);
  const firstVideoSegment = firstVideoTrack?.playlist?.mediaParts[0]?.mediaSegments[0];
  expect(firstVideoSegment?.url).toBe(url!.replace('Manifest_1080p.mpd', '1/0001.m4s'));

  const firstSubtitleTrack = streams.find((stream) => stream.mediaType === MEDIA_TYPES.SUBTITLES);
  expect(firstSubtitleTrack?.codecs, 'wvtt');
  expect(firstSubtitleTrack?.language, 'ru');
});

// test('mpd extraction from url', async () => {
//   const url =
//     'https://dash.akamaized.net/dash264/TestCases/1a/sony/SNE_DASH_SD_CASE1A_REVISED.mpd';
//   const parserConfig = new ParserConfig();
//   const streamExtractor = new StreamExtractor(parserConfig);
//   await streamExtractor.loadSourceFromUrl(url);
//   const streams = await streamExtractor.extractStreams();
//   console.log(streams);
// });
