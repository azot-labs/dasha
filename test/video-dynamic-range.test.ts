import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';
import { expect, test } from 'vitest';
import { DASH_FORMATS, FilePathSource, HLS_FORMATS, Input, UrlSource } from '../src';
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

test.each([
  { codec: 'vp09.02.10.10.01.09.16.09.00', range: 'hdr10', transfer: 'pq' },
  { codec: 'vp09.02.10.10.01.09.18.09.00', range: 'hlg', transfer: 'hlg' },
  { codec: 'vp09.00.10.08.01.01.01.01.00', range: 'sdr', transfer: 'bt709' },
])(
  'reads $range from the media when DASH properties only label quality',
  async ({ codec, range, transfer }) => {
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const video = new EncodedVideoPacketSource('vp9');
    output.addVideoTrack(video);
    await output.start();
    await video.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 1), {
      decoderConfig: { codec, codedWidth: 1920, codedHeight: 1080 },
    });
    await output.finalize();

    const manifest = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1S">
    <Period duration="PT1S">
      <AdaptationSet mimeType="video/mp4" codecs="vp09.02.10.10">
        <SupplementalProperty schemeIdUri="urn:mpeg:yandex:labels:quality" value="1920x1080:1080p" />
        <Representation id="video" width="1920" height="1080" bandwidth="3000000">
          <BaseURL>video.mp4</BaseURL>
        </Representation>
      </AdaptationSet>
    </Period>
  </MPD>`;
    using input = new Input({
      source: new UrlSource('https://media.test/manifest.mpd', {
        fetchFn: async (url) =>
          new Response(String(url).endsWith('.mpd') ? manifest : output.target.buffer!),
      }),
      formats: DASH_FORMATS,
    });

    const track = (await input.getPrimaryVideoTrack())!;
    expect(await track.getDynamicRange()).toBe(range);
    expect((await track.getColorSpace()).transfer).toBe(transfer);
  },
);
