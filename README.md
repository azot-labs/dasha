# dasha

[![npm version](https://img.shields.io/npm/v/dasha?style=flat&color=black)](https://www.npmjs.com/package/dasha)
[![npm downloads/month](https://img.shields.io/npm/dm/dasha?style=flat&color=black)](https://www.npmjs.com/package/dasha)
[![npm downloads](https://img.shields.io/npm/dt/dasha?style=flat&color=black)](https://www.npmjs.com/package/dasha)

Library for parsing MPEG-DASH (.mpd) and HLS (.m3u8) manifests. Made with the purpose of obtaining a simplified representation convenient for further downloading of segments.

> [!WARNING]  
> This README is for the alpha version. Info about latest stable version is available on [NPM](https://www.npmjs.com/package/dasha/v/3.1.5) or [another GitHub branch](https://github.com/streamyx-labs/dasha/tree/v3).


## Install

```shell
npm i dasha@4.0.0-alpha.1
```

## Usage

```js
import fs from 'node:fs/promises';
import { parse } from 'dasha';

const url = 'https://dash.akamaized.net/dash264/TestCases/1a/sony/SNE_DASH_SD_CASE1A_REVISED.mpd';
const body = await fetch(url).then((res) => res.text());
const manifest = await parse(body, url);

for (const track of manifest.tracks.all) {
  for (const segment of track.segments) {
    const content = await fetch(url).then((res) => res.arrayBuffer());
    await fs.appendFile(`${track.id}.mp4`, content);
  }
}
```

## Credits

This project is heavily influenced by the robust implementation found in [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE). Special thanks to the open-source community and contributors who make projects like this possible.

## Licenses

This project is licensed under the [MIT License](LICENSE).
