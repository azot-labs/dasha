'use strict';

const { getBestTrack } = require('./util');

const parseMimes = (codecs) =>
  codecs
    .toLowerCase()
    .split(',')
    .map((codec) => codec.trim().split('.')[0]);

const createResolutionFilter = (videos) => {
  return ({ width, height }) => {
    return videos.filter(
      (track) => (!width || track.width === width) && (!height || track.height === height)
    );
  };
};

const createCodecFilter = (tracks) => {
  return (codecs) => {
    if (!codecs?.length) return tracks;
    const results = tracks.filter((track) => codecs.includes(track.codec));
    results.sort((a, b) => b.bitrate.bps - a.bitrate.bps);
    return results;
  };
};

const createVideoCodecFilter = (videos) => createCodecFilter(videos);

const createVideoQualityFilter = (videos) => {
  return (quality) => {
    if (!quality) return [getBestTrack(videos)];
    const trackQuality = String(quality).includes('p') ? quality : `${quality}p`;
    const results = videos.filter((track) => track.quality === trackQuality);
    results.sort((a, b) => b.bitrate.bps - a.bitrate.bps);
    return results.length ? results : [getBestTrack(videos)];
  };
};

const createAudioCodecFilter = (audios) => createCodecFilter(audios);

const createAudioLanguageFilter = (audios) => {
  return (languages = [], maxTracksPerLanguage) => {
    if (!languages.length) {
      for (const audio of audios) {
        const alreadyAdded = languages.includes(audio.language);
        if (!alreadyAdded) languages.push(audio.language);
      }
    }
    const filtered = [];
    for (const language of languages) {
      const tracks = audios.filter((track) => track.language?.startsWith(language));
      filtered.push(...tracks);
    }
    const results = [];
    const filteredLanguages = [...new Set(filtered.map((track) => track.language))];
    for (const language of filteredLanguages) {
      const tracks = filtered
        .filter((track) => track.language === language)
        .slice(0, maxTracksPerLanguage);
      results.push(...tracks);
    }
    return results;
  };
};

const createAudioChannelsFilter = (audios) => {
  return (channels) => {
    if (!channels) return audios;
    const value = typeof channels === 'string' ? parseFloat(channels) : channels;
    return audios.filter((track) => track.channels === value);
  };
};

const createSubtitleLanguageFilter = (subtitles) => {
  return (languages) => {
    if (!languages.length) return subtitles;
    return subtitles.filter((track) =>
      languages.some(
        (language) => track.language?.startsWith(language) || track.label?.startsWith(language)
      )
    );
  };
};

const filterByResolution = (tracks, resolution) => createResolutionFilter(tracks)(resolution);
const filterByQuality = (tracks, quality) => createVideoQualityFilter(tracks)(quality);
const filterByCodecs = (tracks, codecs) => createCodecFilter(tracks)(codecs);
const filterByLanguages = (tracks, languages, maxTracksPerLanguage) =>
  createAudioLanguageFilter(tracks)(languages, maxTracksPerLanguage);
const filterByChannels = (tracks, channels) => createAudioChannelsFilter(tracks)(channels);

module.exports = {
  parseMimes,
  createResolutionFilter,
  createVideoCodecFilter,
  createVideoQualityFilter,
  createAudioCodecFilter,
  createAudioLanguageFilter,
  createAudioChannelsFilter,
  createSubtitleLanguageFilter,
  filterByResolution,
  filterByQuality,
  filterByCodecs,
  filterByLanguages,
  filterByChannels,
};
