import { expect, test } from 'vitest';
import { load } from './utils';
import { ParserConfig } from '../lib/parser-config';
import { StreamExtractor } from '../lib/stream-extractor';
import { EXTRACTOR_TYPES } from '../lib/shared/extractor-type';

const url =
  'https://edge01d.mediavitrina.ru/dashp-livef1/1tv/index.mpd?token=v2.UXXsCCSMCCTTVDmhGxWCp9KTljI-HYTKlSF6rqtU3kk.e-Prmld6_GahcPCbaegwQtS8wABF-vXF1h-AkMAH3QM.1760855459.c93d2097d438eb27ad0d7d4396b1d8e7';

test('parse vitrina live dash from text', async () => {
  const { text } = await load('vitrina-dash-live-drm.mpd');

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

  for (const stream of streams) {
    console.log(stream.playlist?.mediaInit?.encryptInfo);
  }

  expect(streams.length).toBe(7);

  const isLiveStreams = streams.every(
    (stream) => stream.playlist?.isLive === true,
  );
  expect(isLiveStreams).toBe(true);
});
