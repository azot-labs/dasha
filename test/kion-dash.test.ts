import { expect, test } from 'vitest';
import { StreamExtractor } from '../lib/stream-extractor';
import { load } from './utils';

test('parse kion mpd from text', async () => {
  const text = await load('kion.mpd');

  const streamExtractor = new StreamExtractor();
  await streamExtractor.loadSourceFromText(text);
  const streams = await streamExtractor.extractStreams();

  expect(streams.length).toBe(5);
});
