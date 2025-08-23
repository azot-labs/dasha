'use strict';

const { dirname, basename } = require('node:path');
const m3u8Parser = require('m3u8-parser');
const {
  createResolutionFilter,
  createVideoQualityFilter,
  createAudioLanguageFilter,
  createSubtitleLanguageFilter,
  createVideoCodecFilter,
  createAudioCodecFilter,
  createAudioChannelsFilter,
} = require('./track');
const { createAudioTrack } = require('./audio');
const { createVideoTrack } = require('./video');

const parseM3u8 = (manifestString) => {
  const parser = new m3u8Parser.Parser();
  parser.push(manifestString);
  parser.end();
  return parser.manifest;
};

const fetchPlaylist = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch playlist (${response.status}): ${url}`);
  const text = await response.text();
  return parseM3u8(text);
};

const parseUrl = (playlistUri, manifestUri) => {
  let value = playlistUri;
  if (!value.startsWith('https://'))
    value = new URL(value, manifestUri).toString() + new URL(manifestUri).search;
  return value;
};

const urlsSame = (url1, url2) => {
  return new URL(url1).pathname === new URL(url2).pathname;
};

const parseMediaGroup = (groups, manifestUri) => {
  const results = [];
  if (!groups) return results;
  for (const [groupId, group] of Object.entries(groups)) {
    for (const [label, entity] of Object.entries(group)) {
      const url = parseUrl(entity.uri, manifestUri);
      const existing = results.find((result) => urlsSame(result.url, url));
      if (!existing)
        results.push({
          groupId,
          id: entity.uri.replace('/', ''),
          type: groupId,
          label,
          language: entity.language,
          url,
          default: entity.default,
        });
    }
  }
  return results;
};

const getAudioPlaylists = (m3u8, manifestUri) => {
  if (!m3u8.mediaGroups) return [];
  return parseMediaGroup(m3u8.mediaGroups.AUDIO, manifestUri);
};

const getSubtitlePlaylists = (m3u8, manifestUri) => {
  if (!m3u8.mediaGroups) return [];
  return parseMediaGroup(m3u8.mediaGroups.SUBTITLES, manifestUri);
};

const getVideoPlaylists = (m3u8, manifestUri) => {
  if (!m3u8.playlists) return [];
  return m3u8.playlists.map((data) => {
    const track = createVideoTrack({
      id: data.uri.replace('/', ''),
      label: data.attributes['NAME'],
      type: 'video',
      codec: data.attributes.CODECS,
      dynamicRange: data.attributes['VIDEO-RANGE'],
      bitrate: data.attributes?.BANDWIDTH,
      width: data.attributes.RESOLUTION?.width,
      height: data.attributes.RESOLUTION?.height,
      fps: data.attributes['FRAME-RATE'],
      language: data.attributes['LANGUAGE'],
    });

    track.url = data.resolvedUri || parseUrl(data.uri, manifestUri);

    return track;
  });
};

const segmentsDto = (data = [], track) => {
  const mapSegment = (item) => {
    let url = item.resolvedUri || item.uri;
    if (!url.startsWith('https://') && track.url) {
      const baseUrl = dirname(track.url) + '/';
      url = new URL(url, baseUrl).toString();
    }
    return {
      url,
      duration: item.duration,
      number: item.number,
      presentationTime: item.presentationTime,
    };
  };
  const segments = data.map(mapSegment);
  const init = data[0].map;
  if (data.length && (init?.resolvedUri || init?.uri)) {
    const url = init?.resolvedUri || parseUrl(init.uri, track.url);
    segments.unshift({
      url: url,
      init: true,
      duration: 0,
      number: 0,
      presentationTime: 0,
    });
  }
  return segments;
};

const parseSegments = (playlist, track) => {
  track.segments = segmentsDto(playlist.segments, track);
  if (playlist.contentProtection) {
    track.protection = {};
    const fairplayLegacy = playlist.contentProtection['com.apple.fps.1_0'];
    if (fairplayLegacy)
      track.protection.fairplay = {
        keyFormat: fairplayLegacy.attributes.KEYFORMAT,
        uri: fairplayLegacy.attributes.URI,
        method: fairplayLegacy.attributes.METHOD,
      };
    const widevine = playlist.contentProtection['com.widevine.alpha'];
    if (widevine) {
      track.protection.widevine = {
        pssh: widevine.pssh,
        uri: widevine.attributes.schemeIdUri,
        keyId: widevine.attributes.keyId,
      };
    }
  }
};

const fetchTrackSegments = (tracks) => {
  return Promise.all(
    tracks.map(async (track) => {
      const playlist = await fetchPlaylist(track.url);
      parseSegments(playlist, track);
    }),
  );
};

const parseManifest = async (manifestString, manifestUri) => {
  const m3u8 = parseM3u8(manifestString);
  const videos = getVideoPlaylists(m3u8, manifestUri);
  const audios = getAudioPlaylists(m3u8, manifestUri);
  const subtitles = getSubtitlePlaylists(m3u8, manifestUri);

  if (!m3u8.playlists && m3u8.segments) {
    // TODO: Handle audio-only manifests
    const { pathname } = new URL(manifestUri);
    const isAudio =
      pathname.includes('.m4a') || pathname.includes('.mp3') || pathname.includes('.opus');
    if (isAudio) {
      const track = createAudioTrack({
        id: 'audio' + basename(pathname),
        label: 'audio',
        type: 'audio',
        codec: '',
        channels: 2,
        jointObjectCoding: '',
        isDescriptive: false,
        bitrate: NaN,
        duration: NaN,
        language: '',
      });
      parseSegments(m3u8, track);
      audios.push(track);
    } else {
      const track = createVideoTrack({
        id: 'video' + basename(pathname),
        label: 'video',
        type: 'video',
        codec: '',
        dynamicRange: '',
        contentProtection: '',
        bitrate: NaN,
        duration: NaN,
        width: NaN,
        height: NaN,
        fps: NaN,
        language: '',
      });
      parseSegments(m3u8, track);
      videos.push(track);
    }
  } else {
    await Promise.all([
      fetchTrackSegments(videos),
      fetchTrackSegments(audios),
      fetchTrackSegments(subtitles),
    ]);
  }

  const manifest = {
    tracks: {
      all: videos.concat(audios).concat(subtitles),
      videos,
      audios,
      subtitles,
      withResolution: createResolutionFilter(videos),
      withVideoCodecs: createVideoCodecFilter(videos),
      withVideoQuality: createVideoQualityFilter(videos),
      withAudioCodecs: createAudioCodecFilter(audios),
      withAudioLanguages: createAudioLanguageFilter(audios),
      withAudioChannels: createAudioChannelsFilter(audios),
      withSubtitleLanguages: createSubtitleLanguageFilter(subtitles),
    },
  };

  return manifest;
};

module.exports = { parseManifest };
