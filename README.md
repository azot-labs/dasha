# dasha

[![npm version](https://img.shields.io/npm/v/dasha?style=flat&color=black)](https://www.npmjs.com/package/dasha)
[![npm downloads/month](https://img.shields.io/npm/dm/dasha?style=flat&color=black)](https://www.npmjs.com/package/dasha)
[![npm downloads](https://img.shields.io/npm/dt/dasha?style=flat&color=black)](https://www.npmjs.com/package/dasha)

Library for working with MPEG-DASH (`.mpd`) manifests and HLS (`.m3u8`) playlists through a Mediabunny-compatible Input API. Made with the purpose of obtaining a simplified representation convenient for further downloading of segments by URLs and getting basic metadata about the tracks.

## Install

```shell
npm install dasha
```

## Usage

### Reading HLS

In the example below, we read the segment information for a specific video track and save it to a file.

```ts
import fs from 'node:fs/promises';
import { desc, HLS_FORMATS, Input, UrlSource } from 'dasha';

async function saveVideo() {
  const input = new Input({
    source: new UrlSource(
      'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/hls.m3u8',
      { requestInit: { headers: { Referer: 'https://bitmovin.com/' } } },
    ),
    formats: HLS_FORMATS,
  });

  const videoTracks = await input.getVideoTracks({
    sortBy: async (track) => [
      desc(await track.getDisplayHeight()),
      // Tracks with matching resolution are sorted by bitrate
      desc(await track.getBitrate()),
    ],
    // Filter out #EXT-X-I-FRAME-STREAM-INF tracks
    filter: async (track) => !(await track.hasOnlyKeyPackets()),
  });

  const bestVideoTrack = videoTracks[0];

  const segments = await bestVideoTrack.getSegments();

  const outputPath = 'output.mp4';
  const urls = segments.map((segment) => segment.location.path);
  const initSegment = segments[0]?.initSegment;
  if (initSegment) urls.unshift(initSegment.location.path);
  for (const url of urls) {
    const content = await fetch(url).then((res) => res.arrayBuffer());
    await fs.appendFile(outputPath, new Uint8Array(content));
  }
};
```

### Reading DASH

Everything here is identical to the example above, with the sole exception that an URL to a DASH manifest is used instead of an HLS playlist.

```ts
import fs from 'node:fs/promises';
import { DASH_FORMATS, Input, UrlSource, desc } from 'dasha';

async function saveDashVideo() {
  const input = new Input({
    source: new UrlSource(
      'https://dash.akamaized.net/dash264/TestCases/1a/netflix/exMPD_BIP_TC1.mpd',
    ),
    formats: DASH_FORMATS,
  });

  const videoTracks = await input.getVideoTracks({
    sortBy: async (track) => [
      desc(await track.getDisplayHeight()),
      desc(await track.getBitrate()),
    ],
  });

  const bestVideoTrack = videoTracks[0];
  const segments = await bestVideoTrack.getSegments();

  const outputPath = 'output.m4s';
  const urls = segments.map((segment) => segment.location.path);
  const initSegment = segments[0]?.initSegment;
  if (initSegment) urls.unshift(initSegment.location.path);
  for (const url of urls) {
    const content = await fetch(url).then((res) => res.arrayBuffer());
    await fs.appendFile(outputPath, new Uint8Array(content));
  }
}
```

### Mediabunny with DASH support

> Only reading is supported

Similar to [downloading an HLS playlist as an MP4](https://github.com/Vanilagy/mediabunny/blob/hls/docs/blog/mediabunny-now-supports-hls.md#downloading-an-hls-playlist-as-an-mp4) you can do this:

```ts
import { Conversion, FilePathTarget, Mp4OutputFormat, Output, Input, UrlSource } from 'mediabunny';
import { DASH_FORMATS } from 'dasha';

const input = new Input({
	source: new UrlSource('https://example.com/manifest.mpd'),
	formats: DASH_FORMATS,
});

const output = new Output({
	format: new Mp4OutputFormat(),
	target: new FilePathTarget('output.mp4'),
});

const conversion = await Conversion.init({ input, output });
await conversion.execute();

// Done
```

See [reading HLS](https://github.com/Vanilagy/mediabunny/blob/hls/docs/guide/reading-hls.md) guide for more use cases (many things can be used with DASH as well).

## Credits

[mediabunny](https://github.com/Vanilagy/mediabunny)
