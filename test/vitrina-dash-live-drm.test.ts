import { expect, test } from 'vitest';
import { load } from './utils';
import { ParserConfig } from '../lib/parser-config';
import { StreamExtractor } from '../lib/stream-extractor';
import { EXTRACTOR_TYPES } from '../lib/shared/extractor-type';

const url =
  'https://edge01d.mediavitrina.ru/dashp-livef1/1tv/index.mpd?token=v2.UXXsCCSMCCTTVDmhGxWCp9KTljI-HYTKlSF6rqtU3kk.e-Prmld6_GahcPCbaegwQtS8wABF-vXF1h-AkMAH3QM.1760855459.c93d2097d438eb27ad0d7d4396b1d8e7';

test('parse live dash from vitrina', async () => {
  const { text } = await load('dash-live-drm-vitrina.mpd');

  const parseConfig = new ParserConfig();
  const extractor = new StreamExtractor(parseConfig);
  extractor.loadSourceFromText(text, url);
  const streams = await extractor.extractStreams();

  const shouldFetchPlayList =
    streams.some((stream) => !stream.playlist) ||
    extractor.extractorType === EXTRACTOR_TYPES.MPEG_DASH ||
    extractor.extractorType === EXTRACTOR_TYPES.MSS;

  if (shouldFetchPlayList) {
    await extractor.fetchPlayList(streams);
  }

  expect(streams.length).toBe(7);

  const video = streams.find((stream) => stream.type === 'video');
  const encryptInfo = video?.playlist?.mediaInit?.encryptInfo;
  expect(encryptInfo?.drm.widevine?.pssh).toBe(
    'AAAAeXBzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAAFkIARIgZTY0YzNkZDczNmUyMWZiMGExYjQ4MjQ2MTljOGFkODQaDWNkbm5vd3ZpdHJpbmEiJDAyNmRhN2U5LTBkMzUtNGRiMi1hZGVhLTIxZjkyYTA4ZDMyYQ==',
  );

  const isLiveStreams = streams.every((stream) => stream.playlist?.isLive === true);
  expect(isLiveStreams).toBe(true);
});
