import { expect, test } from 'vitest';
import { DASH_FORMATS, FilePathSource, HLS_FORMATS, Input } from '../src';
import { inferDynamicRange } from '../src/video';
import { assetPath, createAssetInput } from './utils';

test('derive dynamic range labels from HLS VIDEO-RANGE metadata', async () => {
  using input = new Input({
    source: new FilePathSource(assetPath('hls-dynamic-range.m3u8')),
    formats: HLS_FORMATS,
  });

  const tracks = await input.getVideoTracks();
  const byCodec = new Map(
    await Promise.all(
      tracks.map(async (track) => [await track.getCodecParameterString(), track] as const),
    ),
  );

  expect(await byCodec.get('avc1.64001f')!.getDynamicRange()).toBe('sdr');
  expect(await byCodec.get('hvc1.2.4.L120.90')!.getDynamicRange()).toBe('hlg');
  expect(await byCodec.get('hvc1.2.4.L150.90')!.getDynamicRange()).toBe('hdr10');
});

test('expose DASH manifest CICP data through color space and dynamic range', async () => {
  using input = createAssetInput('dash-dynamic-range.mpd', DASH_FORMATS);

  const track = (await input.getPrimaryVideoTrack())!;
  expect(await track.getDynamicRange()).toBe('hdr10');
  expect(await track.getColorSpace()).toEqual({
    primaries: 'bt2020',
    transfer: 'pq',
    matrix: 'bt2020-ncl',
  });
});

test('classify Dolby Vision from codec metadata on non-HLS paths', () => {
  expect(inferDynamicRange({ codecs: 'dvh1.05.06' })).toBe('dv');
});
