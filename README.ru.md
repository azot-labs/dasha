# dasha

[![npm version](https://img.shields.io/npm/v/dasha?style=flat&color=white)](https://www.npmjs.com/package/dasha)
[![npm downloads/month](https://img.shields.io/npm/dm/dasha?style=flat&color=white)](https://www.npmjs.com/package/dasha)
[![npm downloads](https://img.shields.io/npm/dt/dasha?style=flat&color=white)](https://www.npmjs.com/package/dasha)

Библиотека для парсинга MPEG-DASH (.mpd) и HLS (.m3u8) манифестов. Создана с целью получения упрощенного представления, удобного для дальнейшей загрузки сегментов.

<div align="left">
  <a href="https://github.com/vitalygashkov/dasha/tree/main/README.md">English</a> •
  <span>Русский</span>
</div>

## Установка

```shell
npm i dasha
```

## Быстрый старт

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
