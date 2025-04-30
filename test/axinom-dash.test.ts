import { expect, test } from 'vitest';
import { StreamExtractor } from '../lib/stream-extractor';
import { MEDIA_TYPES } from '../lib/shared/media-type';
import { ParserConfig } from '../lib/config/parser-config';
import { load } from './utils';

test('parse axinom mpd from text', async () => {
  const url = 'https://media.axprod.net/TestVectors/v7-MultiDRM-SingleKey/Manifest_1080p.mpd';
  const text = await load('axinom.mpd');

  const parseConfig = new ParserConfig();
  const streamExtractor = new StreamExtractor(parseConfig);
  await streamExtractor.loadSourceFromText(text, url);
  const streams = await streamExtractor.extractStreams();

  const firstVideoTrack = streams.find((stream) => stream.mediaType === MEDIA_TYPES.VIDEO);
  const firstVideoSegment = firstVideoTrack?.playlist?.mediaParts[0]?.mediaSegments[0];
  expect(firstVideoSegment?.url).toBe(
    'https://media.axprod.net/TestVectors/v7-MultiDRM-SingleKey/1/0001.m4s',
  );

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
