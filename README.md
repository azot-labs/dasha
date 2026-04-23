# dasha

[![npm version](https://img.shields.io/npm/v/dasha?style=flat&color=black)](https://www.npmjs.com/package/dasha)
[![npm downloads/month](https://img.shields.io/npm/dm/dasha?style=flat&color=black)](https://www.npmjs.com/package/dasha)
[![npm downloads](https://img.shields.io/npm/dt/dasha?style=flat&color=black)](https://www.npmjs.com/package/dasha)

Library for parsing MPEG-DASH (.mpd) and HLS (.m3u8) manifests. Made with the purpose of obtaining a simplified representation convenient for further downloading of segments.

> [!WARNING]  
> This README is for the alpha version. Info about latest stable version is available on [NPM](https://www.npmjs.com/package/dasha/v/3.1.5) or [another GitHub branch](https://github.com/azot-labs/dasha/tree/v3).


## Install

```shell
npm install dasha@alpha
```

## Usage

```js
import fs from 'node:fs/promises';
import { StreamExtractor } from 'dasha';

const url = 'https://dash.akamaized.net/dash264/TestCases/1a/sony/SNE_DASH_SD_CASE1A_REVISED.mpd';
const streamExtractor = new StreamExtractor();
await streamExtractor.loadSourceFromUrl(url);
const streams = await streamExtractor.extractStreams();

for (const stream of streams) {
  const segments = stream.playlist?.mediaParts[0].mediaSegments || [];
  const filename = `${stream.name}_${stream.groupId}`;
  for (const segment of segments) {
    const content = await fetch(segment.url).then((res) => res.arrayBuffer());
    await fs.appendFile(`${filename}.${stream.extension}`, content);
  }
}
```

### New API (HLS-only for now)

```ts
import fs from 'node:fs/promises';
import { getSegments, desc, HLS_FORMATS, Input, UrlSource } from 'dasha';

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

  const segments = await getSegments(bestVideoTrack);

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

## Credits

[mediabunny](https://github.com/Vanilagy/mediabunny)
[N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE)
