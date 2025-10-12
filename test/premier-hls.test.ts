import { expect, test } from 'vitest';
import { load } from './utils';
import { ParserConfig } from '../lib/parser-config';
import { StreamExtractor } from '../lib/stream-extractor';
import { EXTRACTOR_TYPES } from '../lib/shared/extractor-type';

const url =
  'https://vb-rtb.uma.media/1760336663/5JejsIGqGwxqPGbth1NLYQ/vod/vod:premier/9bc05068c5b44945a1876beda6de049c.m3u8?streams=8bf7e924-23f5-4737-a387-d76864b8940a:w:1920:h:1072:vb:4499968:ab:192000:d:5024920:vc:avc1.640029:ac:mp4a.40.2,2bbe8dd4-ad88-47d3-ab22-f39382b6b794:w:1280:h:720:vb:3000000:ab:128000:d:5024920:vc:avc1.640029:ac:mp4a.40.2,3b1bb1a6-7d55-4348-a8b9-8be3c211557b:w:848:h:480:vb:1499968:ab:128000:d:5024920:vc:avc1.4d401f:ac:mp4a.40.2,a28d9d4a-5c69-41ae-a339-c89127dd3a31:w:640:h:368:vb:1299968:ab:64000:d:5024920:vc:avc1.42c01f:ac:mp4a.40.2';

test('parse premier m3u8 from text', async () => {
  const { text } = await load('premier-hls.m3u8');

  const parseConfig = new ParserConfig();
  const extractor = new StreamExtractor(parseConfig);
  extractor.loadSourceFromText(text, url);
  const streams = await extractor.extractStreams();

  const shouldFetchPlayList =
    streams.some((stream) => !stream.playlist) ||
    extractor.extractorType === EXTRACTOR_TYPES.MPEG_DASH ||
    extractor.extractorType === EXTRACTOR_TYPES.MSS;

  if (shouldFetchPlayList) {
    await extractor.fetchPlayList(streams);
  }

  expect(streams.length).toBe(8);
});
