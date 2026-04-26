import { expect, test } from 'vitest';
import { DASH_FORMATS } from '../src';
import { createAssetInput } from './utils';

test('parse crunchyroll mpd through the Input API', async () => {
  using input = createAssetInput('crunchyroll.mpd', DASH_FORMATS);

  const tracks = await input.getTracks();
  expect(tracks).toHaveLength(8);

  const firstVideo = await input.getPrimaryVideoTrack();
  const init = (await firstVideo!.getSegments())[0]?.initSegment;
  expect(init?.location.path).toBe(
    'https://a-vrv.akamaized.net/evs3/8a1b3acce53d49eea0ce2104fae30046/assets/p/c46e06c5fd496e8aec0b6776b97eca3f_,3748583.mp4,3748584.mp4,3748582.mp4,3748580.mp4,3748581.mp4,.urlset/init-f2-v1-x3.mp4?t=exp=1713871228~acl=/evs3/8a1b3acce53d49eea0ce2104fae30046/assets/p/c46e06c5fd496e8aec0b6776b97eca3f_,3748583.mp4,3748584.mp4,3748582.mp4,3748580.mp4,3748581.mp4,.urlset/*~hmac=7dc7daeb338da040c65111a88cbf947505a5897f42d1c433c3858f8d890ed29c',
  );
});
