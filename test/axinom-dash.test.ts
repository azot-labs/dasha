import { expect, test } from 'vitest';
import { StreamExtractor } from '../lib/stream-extractor';
import { ParserConfig } from '../lib/parser-config';
import { load } from './utils';
import { DashExtractor } from '../lib/dash/dash-extractor';

test('parse axinom mpd from text', async () => {
  const { text, url } = await load('axinom-1.mpd');

  const parseConfig = new ParserConfig();
  parseConfig.originalUrl = url!;
  const extractor = new DashExtractor(parseConfig);
  const streamInfos = await extractor.extractStreams(text);

  expect(streamInfos).not.toBeNullable();
  expect(streamInfos.length).toBe(23);

  const first = streamInfos.at(0);
  console.log(first?.toShortString());
  expect(first?.toShortString()).toBe(
    'Vid | 512x288 | 386 Kbps | 1 | avc | 184 segments | Main | ~12m16s',
  );
  expect(first?.audioId).toBe('15');
  expect(first?.bitrate).toBe(386437);
  expect(first?.languageCode).toBe('und');
  expect(first?.subtitleId).toBe('25');

  expect(first?.playlist).not.toBeNullable();
  expect(first?.playlist?.isLive).toBeFalsy();
  expect(first?.playlist?.totalDuration).toBe(736);
  expect(first?.playlist?.mediaInit).not.toBeNullable();
  expect(first?.playlist?.mediaInit?.url).toBe('1/init.mp4');
  expect(first?.playlist?.mediaParts[0]?.mediaSegments[0]?.url).toBe('1/0001.m4s');
});

test('parse axinom mpd with drm from text', async () => {
  const { text, url } = await load('axinom-2.mpd');

  const parseConfig = new ParserConfig();
  const streamExtractor = new StreamExtractor(parseConfig);
  streamExtractor.loadSourceFromText(text, url);
  const streams = await streamExtractor.extractStreams();

  const firstVideoTrack = streams.find((stream) => stream.type === 'video');
  const firstVideoSegment = firstVideoTrack?.playlist?.mediaParts[0]?.mediaSegments[0];
  expect(firstVideoSegment?.url).toBe(url!.replace('Manifest_1080p.mpd', '1/0001.m4s'));

  const firstSubtitleTrack = streams.find((stream) => stream.type === 'subtitle');
  expect(firstSubtitleTrack?.codecs, 'wvtt');
  expect(firstSubtitleTrack?.languageCode, 'ru');
});
