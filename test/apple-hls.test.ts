import { expect, test } from 'vitest';
import { StreamExtractor } from '../lib/stream-extractor';
import { ParserConfig } from '../lib/parser-config';
import { load } from './utils';

const url =
  'https://play.itunes.apple.com/WebObjects/MZPlay.woa/hls/subscription/playlist.m3u8?cc=US&svcId=tvs.vds.4105&a=1580273278&isExternal=true&brandId=tvs.sbd.4000&id=337246031&l=en-US&aec=UHD&xtrick=true&webbrowser=true';

test('parse apple m3u8 from text', async () => {
  const { text } = await load('apple-hls.m3u8');

  const parseConfig = new ParserConfig();
  const extractor = new StreamExtractor(parseConfig);
  extractor.loadSourceFromText(text, url);
  const streams = await extractor.extractStreams();

  expect(streams.length).toBe(376);
});
