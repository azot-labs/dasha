import { expect, test } from 'vitest';
import { StreamExtractor } from '../lib/stream-extractor';
import { MEDIA_TYPES } from '../lib/shared/media-type';
import { load } from './utils';

test('parse crunchyroll mpd from text', async () => {
  const text = await load('crunchyroll.mpd');

  const streamExtractor = new StreamExtractor();
  await streamExtractor.loadSourceFromText(text);
  const streams = await streamExtractor.extractStreams();

  expect(streams.length).toBe(8);

  const initUrl =
    'https://a-vrv.akamaized.net/evs3/8a1b3acce53d49eea0ce2104fae30046/assets/p/c46e06c5fd496e8aec0b6776b97eca3f_,3748583.mp4,3748584.mp4,3748582.mp4,3748580.mp4,3748581.mp4,.urlset/init-f1-v1-x3.mp4?t=exp=1713871228~acl=/evs3/8a1b3acce53d49eea0ce2104fae30046/assets/p/c46e06c5fd496e8aec0b6776b97eca3f_,3748583.mp4,3748584.mp4,3748582.mp4,3748580.mp4,3748581.mp4,.urlset/*~hmac=7dc7daeb338da040c65111a88cbf947505a5897f42d1c433c3858f8d890ed29c';
  const firstVideo = streams.find((stream) => stream.mediaType === MEDIA_TYPES.VIDEO);
  const init = firstVideo?.playlist?.mediaInit;
  expect(init?.url).toBe(initUrl);
});
