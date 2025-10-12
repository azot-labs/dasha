import { readFile } from 'node:fs/promises';
import { MEDIA_TYPES } from '../shared/media-type';
import { EXTRACTOR_TYPES, type ExtractorType } from 'lib/shared/extractor-type';
import { Extractor } from '../extractor';
import { ParserConfig } from 'lib/parser-config';
import { HLS_TAGS } from 'lib/hls/hls-tags';
import { StreamSpec } from 'lib/shared/stream-spec';
import { combineUrl, distinctBy, getAttribute } from 'lib/shared/util';
import { Playlist } from 'lib/shared/playlist';
import { MediaPart } from 'lib/shared/media-part';
import { EncryptInfo } from 'lib/shared/encrypt-info';
import { MediaSegment } from 'lib/shared/media-segment';
import { ENCRYPT_METHODS } from 'lib/shared/encrypt-method';
import { getRange } from './hls-utils';

export class HlsExtractor implements Extractor {
  get extractorType(): ExtractorType {
    return EXTRACTOR_TYPES.HLS;
  }

  #m3u8Url = '';
  #baseUrl = '';
  #m3u8Content = '';
  #masterM3u8Flag = false;

  parserConfig: ParserConfig;

  constructor(parserConfig: ParserConfig) {
    this.parserConfig = parserConfig;
    this.#m3u8Url = parserConfig.url || '';
    this.#setBaseUrl();
  }

  #setBaseUrl() {
    this.#baseUrl = this.parserConfig.baseUrl || this.#m3u8Url;
  }

  preProcessContent(): void {
    this.#m3u8Content = this.#m3u8Content.trim();
    if (!this.#m3u8Content.startsWith(HLS_TAGS.extM3u)) {
      throw new Error('Invalid m3u8');
    }

    for (const processor of this.parserConfig.contentProcessors) {
      if (processor.canProcess(this.extractorType, this.#m3u8Content, this.parserConfig)) {
        this.#m3u8Content = processor.process(this.#m3u8Content, this.parserConfig);
      }
    }
  }

  preProcessUrl(url: string): string {
    let result = url;
    for (const processor of this.parserConfig.urlProcessors) {
      if (processor.canProcess(this.extractorType, url, this.parserConfig)) {
        result = processor.process(url, this.parserConfig);
      }
    }
    return result;
  }

  async #parseMasterList() {
    this.#masterM3u8Flag = true;
    const streams: StreamSpec[] = [];
    let expectPlaylist = false;
    let streamSpec = new StreamSpec();
    const lines = this.#m3u8Content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.startsWith(HLS_TAGS.extXStreamInf)) {
        streamSpec = new StreamSpec();
        streamSpec.originalUrl = this.parserConfig.originalUrl;
        const bandwidth =
          getAttribute(line, 'AVERAGE-BANDWIDTH') || getAttribute(line, 'BANDWIDTH');
        streamSpec.bandwidth = Number(bandwidth || 0);
        streamSpec.codecs = getAttribute(line, 'CODECS');
        streamSpec.resolution = getAttribute(line, 'RESOLUTION');
        const frameRate = getAttribute(line, 'FRAME-RATE');
        if (frameRate) streamSpec.frameRate = Number(frameRate);
        const audioId = getAttribute(line, 'AUDIO');
        if (audioId) streamSpec.audioId = audioId;
        const videoId = getAttribute(line, 'VIDEO');
        if (videoId) streamSpec.videoId = videoId;
        const subtitleId = getAttribute(line, 'SUBTITLES');
        if (subtitleId) streamSpec.subtitleId = subtitleId;
        const videoRange = getAttribute(line, 'VIDEO-RANGE');
        if (videoRange) streamSpec.videoRange = videoRange;
        if (streamSpec.codecs && streamSpec.audioId) {
          streamSpec.codecs = streamSpec.codecs.split(',')[0];
        }
        expectPlaylist = true;
      } else if (line.startsWith(HLS_TAGS.extXMedia)) {
        streamSpec = new StreamSpec();
        const type = getAttribute(line, 'TYPE').replace('-', '_');
        const mediaType = MEDIA_TYPES[type as keyof typeof MEDIA_TYPES];
        if (mediaType) streamSpec.mediaType = mediaType;
        if (mediaType === MEDIA_TYPES.CLOSED_CAPTIONS) continue;
        let url = getAttribute(line, 'URI');
        if (!url) continue;
        url = combineUrl(this.#baseUrl, url);
        streamSpec.url = this.preProcessUrl(url);
        const groupId = getAttribute(line, 'GROUP-ID');
        if (groupId) streamSpec.groupId = groupId;
        const language = getAttribute(line, 'LANGUAGE');
        if (language) streamSpec.language = language;
        const name = getAttribute(line, 'NAME');
        if (name) streamSpec.name = name;
        const defaultFlag = getAttribute(line, 'DEFAULT');
        if (defaultFlag) streamSpec.default = defaultFlag.toLowerCase() === 'yes';
        const channels = getAttribute(line, 'CHANNELS');
        if (channels) streamSpec.channels = channels;
        const characteristics = getAttribute(line, 'CHARACTERISTICS');
        if (characteristics) {
          streamSpec.characteristics = characteristics.split(',').at(-1)?.split('.').at(-1);
        }
        streams.push(streamSpec);
      } else if (line.startsWith('#')) {
        continue;
      } else if (expectPlaylist) {
        const url = combineUrl(this.#baseUrl, line);
        streamSpec.url = this.preProcessUrl(url);
        expectPlaylist = false;
        streams.push(streamSpec);
      }
    }
    return streams;
  }

  async #parseList() {
    let hasAd = false;

    const allowHlsMultiExtMap =
      this.parserConfig.customParserArgs['allowHlsMultiExtMap'] === 'true';
    if (allowHlsMultiExtMap) {
      console.log(`allowHlsMultiExtMap is set to true`);
    }

    let expectSegment = false;
    let isEndList = false;
    let segIndex = 0;
    let isAd = false;

    const playlist = new Playlist();
    const mediaParts: MediaPart[] = [];

    const currentEncryptInfo = new EncryptInfo();
    if (this.parserConfig.customMethod) {
      currentEncryptInfo.method = this.parserConfig.customMethod;
    }
    if (this.parserConfig.customKey) {
      currentEncryptInfo.key = this.parserConfig.customKey;
    }
    if (this.parserConfig.customIv) {
      currentEncryptInfo.iv = this.parserConfig.customIv;
    }

    let lastKeyLine = '';

    let segment = new MediaSegment();
    let segments: MediaSegment[] = [];

    const lines = this.#m3u8Content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.startsWith(HLS_TAGS.extXByterange)) {
        const p = getAttribute(line);
        const [n, o] = getRange(p);
        segment.expectLength = n;
        segment.startRange =
          o || (segments.at(-1)?.startRange || 0) + (segments.at(-1)?.expectLength || 0);
        expectSegment = true;
      } else if (line.startsWith('#UPLYNK-SEGMENT')) {
        if (line.includes(',ad')) {
          isAd = true;
        } else if (line.includes(',segment')) {
          isAd = false;
        }
      } else if (isAd) {
        continue;
      } else if (line.startsWith(HLS_TAGS.extXTargetDuration)) {
        playlist.targetDuration = Number(getAttribute(line));
      } else if (line.startsWith(HLS_TAGS.extXMediaSequence)) {
        segIndex = Number(getAttribute(line));
      } else if (line.startsWith(HLS_TAGS.extXProgramDateTime)) {
        segment.dateTime = new Date(getAttribute(line));
      } else if (line.startsWith(HLS_TAGS.extXDiscontinuity)) {
        if (hasAd && mediaParts.length) {
          segments = mediaParts.at(-1)?.mediaSegments || [];
          mediaParts.pop();
          hasAd = false;
          continue;
        }
        if (hasAd && !segments.length) continue;
        mediaParts.push(new MediaPart(segments));
        segments = [];
      } else if (line.startsWith(HLS_TAGS.extXKey)) {
        const uri = getAttribute(line, 'URI');
        const uriLast = getAttribute(lastKeyLine, 'URI');
        if (uri !== uriLast) {
          const parsedInfo = await this.#parseKey(line);
          currentEncryptInfo.method = parsedInfo.method;
          currentEncryptInfo.key = parsedInfo.key;
          currentEncryptInfo.iv = parsedInfo.iv;
        }
        lastKeyLine = line;
      } else if (line.startsWith(HLS_TAGS.extInf)) {
        const tmp = getAttribute(line).split(',');
        segment.duration = Number(tmp[0]);
        segment.index = segIndex;
        if (currentEncryptInfo.method != ENCRYPT_METHODS.NONE) {
          segment.encryptInfo.method = currentEncryptInfo.method;
          segment.encryptInfo.key = currentEncryptInfo.key;
          segment.encryptInfo.iv = currentEncryptInfo.iv;
        }
        expectSegment = true;
        segIndex++;
      } else if (line.startsWith(HLS_TAGS.extXEndlist)) {
        if (segments.length > 0) {
          mediaParts.push(new MediaPart(segments));
        }
        segments = [];
        isEndList = true;
      } else if (line.startsWith(HLS_TAGS.extXMap)) {
        if (!playlist.mediaInit || hasAd) {
          const mediaSegment = new MediaSegment();
          mediaSegment.url = this.preProcessUrl(
            combineUrl(this.#baseUrl, getAttribute(line, 'URI')),
          );
          mediaSegment.index = -1;
          playlist.mediaInit = mediaSegment;
          if (line.includes('BYTERANGE')) {
            const p = getAttribute(line, 'BYTERANGE');
            const [n, o] = getRange(p);
            mediaSegment.expectLength = n;
            mediaSegment.startRange = o || 0;
          }
          if (currentEncryptInfo.method === ENCRYPT_METHODS.NONE) continue;
          playlist.mediaInit.encryptInfo.method = currentEncryptInfo.method;
          playlist.mediaInit.encryptInfo.key = currentEncryptInfo.key;
          playlist.mediaInit.encryptInfo.iv = currentEncryptInfo.iv;
        } else {
          if (segments.length) {
            mediaParts.push(new MediaPart(segments));
          }
          segments = [];
          if (!allowHlsMultiExtMap) {
            isEndList = true;
            break;
          }
        }
      } else if (line.startsWith('#')) {
        continue;
      } else if (line.startsWith('\r\n')) {
        continue;
      } else if (expectSegment) {
        const segUrl = this.preProcessUrl(combineUrl(this.#baseUrl, line));
        segment.url = segUrl;
        segments.push(segment);
        segment = new MediaSegment();
        if (segUrl.includes('ccode=') && segUrl.includes('/ad/') && segUrl.includes('duratio=')) {
          segments.pop();
          segIndex--;
          hasAd = true;
        }
        if (segUrl.includes('ccode=0902') && segUrl.includes('duration=')) {
          segments.pop();
          segIndex--;
          hasAd = false;
        }
        expectSegment = false;
      }
    }

    if (!isEndList) {
      mediaParts.push(new MediaPart(segments));
    }

    playlist.mediaParts = mediaParts;
    playlist.isLive = !isEndList;

    if (playlist.isLive) {
      playlist.refreshIntervalMs = (playlist.targetDuration || 5) * 2 * 1000;
    }

    return playlist;
  }

  async #parseKey(keyLine: string) {
    for (const p of this.parserConfig.keyProcessors) {
      if (
        p.canProcess(
          this.extractorType,
          keyLine,
          this.#m3u8Url,
          this.#m3u8Content,
          this.parserConfig,
        )
      ) {
        return p.process(keyLine, this.#m3u8Url, this.#m3u8Content, this.parserConfig);
      }
    }
    throw new Error('No key processor found');
  }

  async extractStreams(rawText: string): Promise<StreamSpec[]> {
    this.#m3u8Content = rawText;
    this.preProcessContent();
    if (this.#m3u8Content.includes(HLS_TAGS.extXStreamInf)) {
      return this.#parseMasterList().then((lists) => distinctBy(lists, (list) => list.url));
    }

    const playlist = await this.#parseList();
    const streamSpec = new StreamSpec();
    streamSpec.url = this.parserConfig.url;
    streamSpec.playlist = playlist;
    streamSpec.extension = playlist.mediaInit ? 'mp4' : 'ts';
    return [streamSpec];
  }

  async #loadM3u8FromUrl(url: string) {
    if (url.startsWith('file:')) {
      const uri = new URL(url);
      const filePath = uri.pathname;
      this.#m3u8Content = await readFile(filePath, 'utf8');
    } else if (url.startsWith('http')) {
      try {
        const response = await fetch(url, {
          headers: this.parserConfig.headers,
        });
        url = response.url;
        this.#m3u8Content = await response.text();
      } catch (e) {
        if (url !== this.parserConfig.originalUrl) {
          const response = await fetch(this.parserConfig.originalUrl, {
            headers: this.parserConfig.headers,
          });
          url = response.url;
          this.#m3u8Content = await response.text();
        }
      }
    }

    this.#m3u8Url = url;
    this.#setBaseUrl();
    this.preProcessContent();
  }

  async #refreshUrlFromMaster(lists: StreamSpec[]) {
    await this.#loadM3u8FromUrl(this.parserConfig.url);
    const newStreams = await this.#parseMasterList().then((lists) =>
      distinctBy(lists, (list) => list.url),
    );
    for (const list of lists) {
      const match = newStreams.filter((stream) => stream.toShortString() === list.toShortString());
      if (!match.length) continue;
      list.url = match.at(0)!.url;
    }
  }

  async fetchPlayList(lists: StreamSpec[]): Promise<void> {
    for (const list of lists) {
      try {
        await this.#loadM3u8FromUrl(list.url!);
      } catch (e) {
        if (this.#masterM3u8Flag) {
          console.warn('Can not load m3u8. Try refreshing url from master url...');
        }
        await this.#refreshUrlFromMaster(lists);
        await this.#loadM3u8FromUrl(list.url!);
      }

      const newPlaylist = await this.#parseList();
      if (list.playlist?.mediaInit) {
        list.playlist.mediaParts = newPlaylist.mediaParts;
      } else {
        list.playlist = newPlaylist;
      }

      if (list.mediaType === MEDIA_TYPES.SUBTITLES) {
        const a = list.playlist.mediaParts.some((part) =>
          part.mediaSegments.some((segment) => segment.url.includes('.ttml')),
        );
        const b = list.playlist.mediaParts.some((part) =>
          part.mediaSegments.some(
            (segment) => segment.url.includes('.vtt') || segment.url.includes('.webvtt'),
          ),
        );
        if (a) list.extension = 'ttml';
        if (b) list.extension = 'vtt';
      } else {
        list.extension = list.playlist.mediaInit ? 'm4s' : 'ts';
      }
    }
  }

  async refreshPlayList(streamSpecs: StreamSpec[]): Promise<void> {
    await this.fetchPlayList(streamSpecs);
  }
}
