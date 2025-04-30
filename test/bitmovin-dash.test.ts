import { expect, test } from 'vitest';
import { StreamExtractor } from '../lib/stream-extractor';
import { MEDIA_TYPES } from '../lib/shared/media-type';
import { load } from './utils';

test('parse bitmovin mpd from text', async () => {
  const url = 'https://cdn.bitmovin.com/content/assets/art-of-motion_drm/mpds/11331.mpd';
  const text = await load('bitmovin.mpd');

  const streamExtractor = new StreamExtractor();
  await streamExtractor.loadSourceFromText(text, url);
  const streams = await streamExtractor.extractStreams();

  expect(streams.length).toBe(7);

  const firstAudioTrack = streams.find((stream) => stream.mediaType === MEDIA_TYPES.AUDIO);
  //   strictEqual(
  //     firstAudioTrack.protection.widevine.pssh,
  //     'AAAAW3Bzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAADsIARIQ62dqu8s0Xpa7z2FmMPGj2hoNd2lkZXZpbmVfdGVzdCIQZmtqM2xqYVNkZmFsa3IzaioCSEQyAA==',
  //   );
});
