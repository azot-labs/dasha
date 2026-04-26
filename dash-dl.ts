import {
  Conversion,
  FilePathTarget,
  Mp4OutputFormat,
  Output,
  Input,
  UrlSource,
  desc,
} from 'mediabunny';
import { DASH_FORMATS } from './src';

// const keys = new Map([['eb676abbcb345e96bbcf616630f1a3da', '100b6c20940f779a4589152b57d2dacb']]);
// const encryptedUrl = 'https://cdn.bitmovin.com/content/assets/art-of-motion_drm/mpds/11331.mpd';

const unencryptedUrl = 'https://media.axprod.net/TestVectors/v7-Clear/Manifest_1080p.mpd';

async function main() {
  const input = new Input({
    source: new UrlSource(unencryptedUrl),
    formats: DASH_FORMATS,
    // formatOptions: {
    //   isobmff: {
    //     resolveKeyId: ({ keyId }) => {
    //       const key = keys.get(keyId);
    //       if (!key) throw new Error(`Key not found for keyId: ${keyId}`);
    //       return key;
    //     },
    //   },
    // },
  });

  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new FilePathTarget('output.mp4'),
  });

  const selectedVideo = (
    await input.getVideoTracks({
      filter: async (track) =>
        !(await track.hasOnlyKeyPackets()) && (await track.getDisplayHeight()) === 360,
      sortBy: async (track) => desc(await track.getBitrate()),
    })
  )[0];

  const selectedAudio = await selectedVideo.getPrimaryPairableAudioTrack({
    filter: async (track) => {
      const lang = await track.getLanguageCode();
      console.log(await track.getName());
      console.log(lang);
      return lang === 'en';
    },
  });

  if (!selectedAudio) {
    throw new Error('No Russian audio track pairable with the selected 360p video.');
  }

  const conversion = await Conversion.init({
    input,
    output,
    tracks: 'all',
    video: async (track) => ({
      discard: track.number !== selectedVideo.number,
    }),
    audio: async (track) => ({
      discard: track.number !== selectedAudio.number,
    }),
  });

  conversion.onProgress = (progress) => {
    console.log(`Progress: ${Math.round(progress * 100)}%`);
  };

  await conversion.execute();
}

main();
