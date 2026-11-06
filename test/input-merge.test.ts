import {
  BufferSource,
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';
import { expect, test } from 'vitest';
import { ALL_FORMATS, DASH_FORMATS, FilePathSource, Input, UrlSource } from '../src';
import { assetFileUrl, assetPath, createAssetInput } from './utils';

test('merge lists the tracks of every input in order under unique IDs', async () => {
  const first = createAssetInput('bitmovin.mpd', DASH_FORMATS);
  const second = createAssetInput('multiple-audio-adaptation-sets.mpd', DASH_FORMATS);
  using merged = Input.merge([first, second]);

  const origins = [...(await first.getTracks()), ...(await second.getTracks())];
  const tracks = await merged.getTracks();

  expect(tracks).toHaveLength(origins.length);
  tracks.forEach((track, index) => {
    expect(track.origin).toBe(origins[index]);
    expect(track.input).toBe(merged);
    expect(track.id).toBe(index + 1);
    expect(track.source).toBe(track.origin.input.source);
  });
  expect(origins[0]!.origin).toBe(origins[0]);
  expect((await merged.getVideoTracks()).map((track) => track.number)).toEqual([
    1, 2, 3, 4, 5, 6, 7,
  ]);
  expect((await merged.getAudioTracks()).map((track) => track.number)).toEqual([1, 2, 3, 4]);
  expect(await tracks[0]!.getSegments()).toEqual(await origins[0]!.getSegments());
});

test('merge pairs tracks of different inputs and keeps the pairing of each input', async () => {
  const first = createAssetInput('bitmovin.mpd', DASH_FORMATS);
  const [unpairedAudio] = await first.addAudioTracks(
    new UrlSource(assetFileUrl('audio-only-segment-base.mpd')),
    { pairWith: false, filter: async (track) => (await track.getLanguageCode()) === 'es' },
  );
  const second = createAssetInput('multiple-audio-adaptation-sets.mpd', DASH_FORMATS);
  using merged = Input.merge([first, second]);

  const videos = await merged.getVideoTracks();
  const audios = await merged.getAudioTracks();
  const firstVideos = videos.filter((track) => track.origin.input === first);
  const secondVideos = videos.filter((track) => track.origin.input === second);
  const firstAudio = audios.find(
    (track) => track.origin.input === first && track.origin !== unpairedAudio,
  )!;
  const mergedUnpairedAudio = audios.find((track) => track.origin === unpairedAudio)!;
  const secondAudios = audios.filter((track) => track.origin.input === second);

  for (const video of firstVideos) {
    expect(video.canBePairedWith(firstAudio)).toBe(true);
    expect(video.canBePairedWith(mergedUnpairedAudio)).toBe(false);
    for (const audio of secondAudios) expect(video.canBePairedWith(audio)).toBe(true);
    for (const other of secondVideos) expect(video.canBePairedWith(other)).toBe(false);
  }
  for (const video of secondVideos) {
    expect(video.canBePairedWith(mergedUnpairedAudio)).toBe(true);
    expect(video.canBePairedWith(firstAudio)).toBe(true);
  }
  for (const track of [...videos, ...audios]) {
    for (const other of [...videos, ...audios]) {
      if (track === other || track.origin.input !== other.origin.input) continue;
      expect(track.canBePairedWith(other)).toBe(track.origin.canBePairedWith(other.origin));
    }
  }
});

test('changes to tracks of a merged input stay off the tracks it merged', async () => {
  const first = createAssetInput('bitmovin.mpd', DASH_FORMATS);
  const second = createAssetInput('multiple-audio-adaptation-sets.mpd', DASH_FORMATS);
  using merged = Input.merge([first, second]);

  const [video] = await merged.getVideoTracks();
  const originAudios = await video!.origin.getPairableAudioTracks();
  const subtitleSource = new FilePathSource(assetPath('hls-subtitles-en-0001.srt'));
  const subtitle = merged.addSubtitleTrack(subtitleSource, { languageCode: 'en', pairWith: video });

  expect(subtitle.canBePairedWith(video!)).toBe(true);
  expect(subtitle.source).toBe(subtitleSource);
  expect(await subtitle.getSegments()).toHaveLength(1);
  expect(await merged.getSubtitleTracks()).toEqual([subtitle]);
  expect(await video!.origin.getPairableAudioTracks()).toEqual(originAudios);

  const [audio] = await merged.getAudioTracks();
  const originLanguage = await audio!.origin.getLanguageCode();
  audio!.setLanguageCode('fr');
  expect(await audio!.getLanguageCode()).toBe('fr');
  expect(await audio!.origin.getLanguageCode()).toBe(originLanguage);
});

test('a merged input has no source or format of its own', async () => {
  using merged = Input.merge([createAssetInput('bitmovin.mpd', DASH_FORMATS)]);

  expect(() => merged.source).toThrow(/merged input/);
  await expect(merged.getFormat()).rejects.toThrow(/merged input/);
});

test('merge rejects no inputs, repeated inputs and disposed inputs', () => {
  using input = createAssetInput('bitmovin.mpd', DASH_FORMATS);
  const disposed = createAssetInput('bitmovin.mpd', DASH_FORMATS);
  disposed.dispose();

  expect(() => Input.merge([])).toThrow(TypeError);
  expect(() => Input.merge([input, input])).toThrow(TypeError);
  expect(() => Input.merge([disposed])).toThrow(TypeError);
});

test('disposing a merged input disposes the inputs it merged', () => {
  const first = createAssetInput('bitmovin.mpd', DASH_FORMATS);
  const second = createAssetInput('multiple-audio-adaptation-sets.mpd', DASH_FORMATS);
  const merged = Input.merge([first, second]);

  merged.dispose();

  expect(first.disposed).toBe(true);
  expect(second.disposed).toBe(true);
});

const createDirectFileInput = async () => {
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const video = new EncodedVideoPacketSource('vp9');
  output.addVideoTrack(video);
  await output.start();
  await video.add(new EncodedPacket(new Uint8Array(16), 'key', 0, 1), {
    decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 1920, codedHeight: 1080 },
  });
  await output.finalize();
  return new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
};

test('merge mixes direct files with manifests', async () => {
  const file = await createDirectFileInput();
  const manifest = createAssetInput('multiple-audio-adaptation-sets.mpd', DASH_FORMATS);
  using merged = Input.merge([file, manifest]);

  const [fileVideo] = await merged.getVideoTracks();
  expect(fileVideo!.origin.input).toBe(file);
  expect(await fileVideo!.getDisplayHeight()).toBe(1080);
  expect(fileVideo!.source).toBe(file.source);
  for (const audio of await merged.getAudioTracks()) {
    expect(fileVideo!.canBePairedWith(audio)).toBe(true);
  }
});
