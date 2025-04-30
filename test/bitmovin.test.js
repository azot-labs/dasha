const { test } = require('node:test');
const { strictEqual } = require('node:assert');
const { parse } = require('../dasha');
const { load } = require('./utils');

test('bitmovin manifest parsing', async () => {
  const url = 'https://cdn.bitmovin.com/content/assets/art-of-motion_drm/mpds/11331.mpd';
  const text = load('bitmovin.mpd');
  const manifest = await parse(text, url);

  const firstAudioTrack = manifest.tracks.audios[0];
  strictEqual(
    firstAudioTrack.protection.widevine.pssh,
    'AAAAW3Bzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAADsIARIQ62dqu8s0Xpa7z2FmMPGj2hoNd2lkZXZpbmVfdGVzdCIQZmtqM2xqYVNkZmFsa3IzaioCSEQyAA==',
  );

  strictEqual(manifest.tracks.all.length, 7);
});
