import { expect, test } from 'vitest';
import { StreamExtractor } from '../lib/stream-extractor';
import { load } from './utils';
import { ParserConfig } from '../lib/parser-config';
import { ENCRYPT_METHODS } from '../lib/shared/encrypt-method';

test('parse hls with drm from bitmovin', async () => {
  const url = 'https://cdn.bitmovin.com/content/assets/art-of-motion_drm/m3u8s/11331.m3u8';
  const { text } = await load('hls-master-drm-bitmovin.m3u8');

  const parseConfig = new ParserConfig();
  const extractor = new StreamExtractor(parseConfig);
  extractor.loadSourceFromText(text, url);
  const streams = await extractor.extractStreams();
  expect(streams.length).toBe(7);

  const firstStream = streams[0];
  await extractor.fetchPlayList([firstStream]);

  const firstSegment = firstStream.playlist?.mediaParts[0]?.mediaSegments[0];

  expect(firstSegment?.encryptInfo?.method).toBe(ENCRYPT_METHODS.AES_128);
  expect(firstSegment?.encryptInfo?.key).toEqual(
    new Uint8Array([202, 181, 181, 41, 174, 40, 213, 204, 94, 62, 123, 195, 253, 74, 84, 77]),
  );
  expect(firstSegment?.encryptInfo?.iv).toEqual(
    new Uint8Array([0, 97, 62, 139, 140, 233, 206, 32, 140, 78, 173, 74, 14, 3, 99, 99, 113]),
  );
});
