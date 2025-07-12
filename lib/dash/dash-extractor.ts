import { Temporal } from 'temporal-polyfill';
import { DOMParser, Element } from '@xmldom/xmldom';
import { EXTRACTOR_TYPES, ExtractorType } from '../shared/extractor-type';
import { ParserConfig } from '../parser-config';
import { ENCRYPT_METHODS, EncryptMethod } from '../shared/encrypt-method';
import { StreamSpec } from '../shared/stream-spec';
import { Extractor } from '../extractor';
import { combineUrl, replaceVars } from '../shared/util';
import { Playlist } from '../shared/playlist';
import { MediaPart } from '../shared/media-part';
import { MEDIA_TYPES } from '../shared/media-type';
import { ROLE_TYPE } from '../shared/role-type';
import { MediaSegment } from '../shared/media-segment';
import { DASH_TAGS } from './dash-tags';
import { EncryptInfo } from '../shared/encrypt-info';
import { parseRange } from './dash-utils';

export class DashExtractor implements Extractor {
  static #DEFAULT_METHOD: EncryptMethod = ENCRYPT_METHODS.CENC;

  get extractorType(): ExtractorType {
    return EXTRACTOR_TYPES.MPEG_DASH;
  }

  #mpdUrl = '';
  #baseUrl = '';
  #mpdContent = '';
  #parserConfig: ParserConfig;

  constructor(parserConfig: ParserConfig) {
    this.#parserConfig = parserConfig;
    this.#setInitUrl();
  }

  #setInitUrl() {
    this.#mpdUrl = this.#parserConfig.url ?? '';
    this.#baseUrl = this.#parserConfig.baseUrl ?? this.#mpdUrl;
  }

  #extendBaseUrl(node: Element, baseUrl: string) {
    const target = node.getElementsByTagName('BaseURL')[0];
    if (target?.textContent) {
      return combineUrl(baseUrl, target.textContent);
    }
    return baseUrl;
  }

  #getFrameRate(node: Element): number | undefined {
    const frameRate = node.getAttribute('frameRate');
    if (!frameRate || !frameRate.includes('/')) return;
    const d = Number(frameRate.split('/')[0]) / Number(frameRate.split('/')[1]);
    return Number(d.toFixed(3));
  }

  async extractStreams(rawText: string): Promise<StreamSpec[]> {
    const streamList: StreamSpec[] = [];

    this.#mpdContent = rawText;

    const document = new DOMParser().parseFromString(this.#mpdContent, 'text/xml');
    const mpdElement = document.getElementsByTagName('MPD')[0];
    const type = mpdElement.getAttribute('type');
    const isLive = type === 'dynamic';

    const maxSegmentDuration = mpdElement.getAttribute('maxSegmentDuration');
    const availabilityStartTime = mpdElement.getAttribute('availabilityStartTime');
    const timeShiftBufferDepth = mpdElement.getAttribute('timeShiftBufferDepth') || 'PT1M';
    const publishTime = mpdElement.getAttribute('publishTime');
    const mediaPresentationDuration = mpdElement.getAttribute('mediaPresentationDuration');

    const baseUrlElement = mpdElement.getElementsByTagName('BaseURL')[0];
    if (baseUrlElement?.textContent) {
      let baseUrl = baseUrlElement.textContent;
      if (baseUrl.includes('kkbox.com.tw/')) {
        baseUrl = baseUrl.replace('//https:%2F%2F', '//');
      }
      this.#baseUrl = combineUrl(this.#mpdUrl, baseUrl);
    }

    const periods = mpdElement.getElementsByTagName('Period');

    for (const period of periods) {
      const periodDuration = period.getAttribute('duration');
      const periodId = period.getAttribute('id');
      const periodDurationSeconds = Temporal.Duration.from(
        periodDuration || mediaPresentationDuration || 'PT0S',
      ).total('seconds');
      let segBaseUrl = this.#extendBaseUrl(period, this.#baseUrl);
      const adaptationSetsBaseUrl = segBaseUrl;
      const adaptationSets = period.getElementsByTagName('AdaptationSet');
      for (const adaptationSet of adaptationSets) {
        segBaseUrl = this.#extendBaseUrl(adaptationSet, segBaseUrl);
        const representationsBaseUrl = segBaseUrl;
        let mimeType =
          adaptationSet.getAttribute('contentType') || adaptationSet.getAttribute('mimeType');
        const frameRate = this.#getFrameRate(adaptationSet);
        const representations = adaptationSet.getElementsByTagName('Representation');
        for (const representation of representations) {
          segBaseUrl = this.#extendBaseUrl(representation, segBaseUrl);
          if (!mimeType) {
            mimeType =
              representation.getAttribute('contentType') ||
              representation.getAttribute('mimeType') ||
              '';
          }
          const bandwidth = representation.getAttribute('bandwidth');
          const streamSpec = new StreamSpec();
          streamSpec.originalUrl = this.#parserConfig.originalUrl;
          streamSpec.periodId = periodId;
          streamSpec.playlist = new Playlist();
          streamSpec.playlist.mediaParts.push(new MediaPart());
          streamSpec.groupId = representation.getAttribute('id');
          streamSpec.bandwidth = Number(bandwidth || 0);
          streamSpec.codecs =
            representation.getAttribute('codecs') || adaptationSet.getAttribute('codecs');
          streamSpec.language = this.#filterLanguage(
            representation.getAttribute('lang') || adaptationSet.getAttribute('lang'),
          );
          streamSpec.frameRate = frameRate || this.#getFrameRate(representation);
          const width = representation.getAttribute('width');
          const height = representation.getAttribute('height');
          streamSpec.resolution = width && height ? `${width}x${height}` : undefined;
          streamSpec.url = this.#mpdUrl;
          const mimeTypePart = mimeType.split('/')[0];
          if (mimeTypePart === 'text') {
            streamSpec.mediaType = MEDIA_TYPES.SUBTITLES;
          } else if (mimeTypePart === 'audio') {
            streamSpec.mediaType = MEDIA_TYPES.AUDIO;
          } else if (mimeTypePart === 'video' || !!streamSpec.resolution) {
            streamSpec.mediaType = MEDIA_TYPES.VIDEO;
          }

          const volumeAdjust = representation.getAttribute('volumeAdjust');
          if (volumeAdjust) {
            streamSpec.groupId = streamSpec.groupId + '-' + volumeAdjust;
          }

          const mType =
            representation.getAttribute('mimeType') || adaptationSet.getAttribute('mimeType');
          if (mType) {
            const mTypeSplit = mType.split('/');
            streamSpec.extension = mTypeSplit.length === 2 ? mTypeSplit[1] : null;
          }

          if (streamSpec.codecs === 'stpp' || streamSpec.codecs === 'wvtt') {
            streamSpec.mediaType = MEDIA_TYPES.SUBTITLES;
          }

          const role =
            representation.getElementsByTagName('Role')[0] ||
            adaptationSet.getElementsByTagName('Role')[0];
          if (role) {
            const roleValue = role.getAttribute('value');
            const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
            const roleTypeKey = roleValue!.split('-').map(capitalize).join('');
            const roleType = ROLE_TYPE[roleTypeKey as keyof typeof ROLE_TYPE];
            streamSpec.role = roleType;
            if (roleType === ROLE_TYPE.Subtitle) {
              streamSpec.mediaType = MEDIA_TYPES.SUBTITLES;
              if (mType?.includes('ttml')) streamSpec.extension = 'ttml';
            } else if (roleType === ROLE_TYPE.ForcedSubtitle) {
              streamSpec.mediaType = MEDIA_TYPES.SUBTITLES;
            }
          }

          streamSpec.playlist.isLive = isLive;

          if (timeShiftBufferDepth) {
            streamSpec.playlist.refreshIntervalMs =
              Temporal.Duration.from(timeShiftBufferDepth).total('milliseconds') / 2;
          }

          const audioChannelConfiguration =
            adaptationSet.getElementsByTagName('AudioChannelConfiguration')[0] ||
            representation.getElementsByTagName('AudioChannelConfiguration')[0];

          if (audioChannelConfiguration) {
            streamSpec.channels = audioChannelConfiguration.getAttribute('value');
          }

          if (publishTime) {
            streamSpec.publishTime = new Date(publishTime);
          }

          const segmentBaseElement = representation.getElementsByTagName('SegmentBase')[0];
          if (segmentBaseElement) {
            const initialization = segmentBaseElement.getElementsByTagName('Initialization')[0];
            if (initialization) {
              const sourceUrl = initialization.getAttribute('sourceURL');
              if (!sourceUrl) {
                const mediaSegment = new MediaSegment();
                mediaSegment.index = 0;
                mediaSegment.url = segBaseUrl;
                mediaSegment.duration = periodDurationSeconds;
                streamSpec.playlist.mediaParts[0].mediaSegments.push(mediaSegment);
              } else {
                const initUrl = combineUrl(segBaseUrl, sourceUrl);
                const initRange = initialization.getAttribute('range');
                const initSegment = new MediaSegment();
                initSegment.index = -1;
                initSegment.url = initUrl;
                if (initRange) {
                  const [start, expect] = parseRange(initRange);
                  initSegment.startRange = start;
                  initSegment.expectLength = expect;
                }
                streamSpec.playlist.mediaInit = initSegment;
              }
            }
          }

          const segmentList = representation.getElementsByTagName('SegmentList')[0];
          if (segmentList) {
            const durationStr = segmentList.getAttribute('duration');
            const initialization = segmentList.getElementsByTagName('Initialization')[0];
            if (initialization) {
              const sourceUrl = initialization.getAttribute('sourceURL')!;
              const initUrl = combineUrl(segBaseUrl, sourceUrl);
              const initRange = initialization.getAttribute('range');
              const initSegment = new MediaSegment();
              initSegment.index = -1;
              initSegment.url = initUrl;
              if (initRange) {
                const [start, expect] = parseRange(initRange);
                initSegment.startRange = start;
                initSegment.expectLength = expect;
              }
              streamSpec.playlist.mediaInit = initSegment;
            }

            const segmentUrls = segmentList.getElementsByTagName('SegmentURL');
            const timescaleStr = segmentList.getAttribute('timescale') || '1';
            for (let segmentIndex = 0; segmentIndex < segmentUrls.length; segmentIndex++) {
              const segmentUrl = segmentUrls[segmentIndex];
              const mediaUrl = combineUrl(segBaseUrl, segmentUrl.getAttribute('media')!);
              const mediaRange = segmentUrl.getAttribute('mediaRange');
              const timescale = Number(timescaleStr);
              const duration = Number(durationStr);
              const segment = new MediaSegment();
              segment.index = segmentIndex;
              segment.url = mediaUrl;
              segment.duration = duration / timescale;
              if (mediaRange) {
                const [start, expect] = parseRange(mediaRange);
                segment.startRange = start;
                segment.expectLength = expect;
              }
              streamSpec.playlist.mediaParts[0].mediaSegments.push(segment);
            }
          }

          const segmentTemplateElementsOuter =
            adaptationSet.getElementsByTagName('SegmentTemplate');
          const segmentTemplateElements = representation.getElementsByTagName('SegmentTemplate');
          if (segmentTemplateElementsOuter.length || segmentTemplateElements.length) {
            const segmentTemplate = segmentTemplateElements[0] || segmentTemplateElementsOuter[0];
            const segmentTemplateOuter =
              segmentTemplateElementsOuter[0] || segmentTemplateElements[0];
            const varDic: Record<string, any> = {};
            varDic[DASH_TAGS.TemplateRepresentationID] = streamSpec.groupId;
            varDic[DASH_TAGS.TemplateBandwidth] = bandwidth;
            const presentationTimeOffsetStr =
              segmentTemplate.getAttribute('presentationTimeOffset') ||
              segmentTemplateOuter.getAttribute('presentationTimeOffset') ||
              '0';
            const timescaleStr =
              segmentTemplate.getAttribute('timescale') ||
              segmentTemplateOuter.getAttribute('timescale') ||
              '1';
            const durationStr =
              segmentTemplate.getAttribute('duration') ||
              segmentTemplateOuter.getAttribute('duration');
            const startNumberStr =
              segmentTemplate.getAttribute('startNumber') ||
              segmentTemplateOuter.getAttribute('startNumber') ||
              '1';
            const initialization =
              segmentTemplate.getAttribute('initialization') ||
              segmentTemplateOuter.getAttribute('initialization');
            if (initialization) {
              const _init = replaceVars(initialization, varDic);
              const initUrl = combineUrl(segBaseUrl, _init);
              const mediaSegment = new MediaSegment();
              mediaSegment.index = -1;
              mediaSegment.url = initUrl;
              streamSpec.playlist.mediaInit = mediaSegment;
            }
            const mediaTemplate =
              segmentTemplate.getAttribute('media') || segmentTemplateOuter.getAttribute('media');
            const segmentTimeline = segmentTemplate.getElementsByTagName('SegmentTimeline')[0];
            if (segmentTimeline) {
              const Ss = segmentTimeline.getElementsByTagName('S');
              let segNumber = Number(startNumberStr);
              let currentTime = 0;
              let segIndex = 0;
              for (const s of Ss) {
                const _startTimeStr = s.getAttribute('t');
                const _durationStr = s.getAttribute('d');
                const _repeatCountStr = s.getAttribute('r');
                if (_startTimeStr) currentTime = Number(_startTimeStr);
                const _duration = Number(_durationStr);
                const timescale = Number(timescaleStr);
                let _repeatCount = Number(_repeatCountStr);
                varDic[DASH_TAGS.TemplateTime] = currentTime;
                varDic[DASH_TAGS.TemplateNumber] = segNumber++;
                const hasTime = mediaTemplate?.includes(DASH_TAGS.TemplateTime);
                const media = replaceVars(mediaTemplate!, varDic);
                const mediaUrl = combineUrl(segBaseUrl, media);
                const mediaSegment = new MediaSegment();
                mediaSegment.url = mediaUrl;
                if (hasTime) {
                  mediaSegment.nameFromVar = currentTime.toString();
                }
                mediaSegment.duration = _duration / timescale;
                mediaSegment.index = segIndex++;
                streamSpec.playlist.mediaParts[0].mediaSegments.push(mediaSegment);
                if (_repeatCount < 0) {
                  _repeatCount = Math.ceil((periodDurationSeconds * timescale) / _duration) - 1;
                }
                for (let i = 0; i < _repeatCount; i++) {
                  currentTime += _duration;
                  const _mediaSegment = new MediaSegment();
                  varDic[DASH_TAGS.TemplateTime] = currentTime;
                  varDic[DASH_TAGS.TemplateNumber] = segNumber++;
                  const _hashTime = mediaTemplate?.includes(DASH_TAGS.TemplateTime);
                  const _media = replaceVars(mediaTemplate!, varDic);
                  const _mediaUrl = combineUrl(segBaseUrl, _media);
                  _mediaSegment.url = _mediaUrl;
                  _mediaSegment.index = segIndex++;
                  _mediaSegment.duration = _duration / timescale;
                  if (_hashTime) {
                    _mediaSegment.nameFromVar = currentTime.toString();
                  }
                  streamSpec.playlist.mediaParts[0].mediaSegments.push(_mediaSegment);
                }
                currentTime += _duration;
              }
            } else {
              const timescale = Number(timescaleStr);
              let startNumber = Number(startNumberStr);
              const duration = Number(durationStr);
              let totalNumber = Math.ceil((periodDurationSeconds * timescale) / duration);
              if (totalNumber === 0 && isLive) {
                const now = Date.now();
                const availableTime = new Date(availabilityStartTime!);
                const offsetMs = Number(presentationTimeOffsetStr) / 1000;
                availableTime.setUTCMilliseconds(availableTime.getUTCMilliseconds() + offsetMs);
                const ts = (now - availableTime.getTime()) / 1000;
                const updateTs = Temporal.Duration.from(timeShiftBufferDepth).total('seconds');
                startNumber += ((ts - updateTs) * timescale) / duration;
                totalNumber = (updateTs * timescale) / duration;
              }

              for (
                let index = startNumber, segIndex = 0;
                index < startNumber + totalNumber;
                index++, segIndex++
              ) {
                varDic[DASH_TAGS.TemplateNumber] = index;
                const hasNumber = mediaTemplate!.includes(DASH_TAGS.TemplateNumber);
                const media = replaceVars(mediaTemplate!, varDic);
                const mediaUrl = combineUrl(segBaseUrl, media!);
                const mediaSegment = new MediaSegment();
                mediaSegment.url = mediaUrl;
                if (hasNumber) mediaSegment.nameFromVar = index.toString();
                mediaSegment.index = isLive ? index : segIndex;
                mediaSegment.duration = duration / timescale;
                streamSpec.playlist.mediaParts[0].mediaSegments.push(mediaSegment);
              }
            }
          }

          if (streamSpec.playlist.mediaParts[0].mediaSegments.length === 0) {
            const mediaSegment = new MediaSegment();
            mediaSegment.index = 0;
            mediaSegment.url = segBaseUrl;
            mediaSegment.duration = periodDurationSeconds;
            streamSpec.playlist.mediaParts[0].mediaSegments.push(mediaSegment);
          }

          const adaptationSetProtections = adaptationSet.getElementsByTagName('ContentProtection');
          const representationProtections =
            representation.getElementsByTagName('ContentProtection');
          const contentProtections = representationProtections[0]
            ? representationProtections
            : adaptationSetProtections;
          if (contentProtections.length) {
            const encryptInfo = new EncryptInfo();
            encryptInfo.method = DashExtractor.#DEFAULT_METHOD;

            for (const contentProtection of contentProtections) {
              const schemeIdUri = contentProtection.getAttribute('schemeIdUri');
              // TODO: Add content protection to stream spec ?
            }

            if (streamSpec.playlist.mediaInit) {
              streamSpec.playlist.mediaInit.encryptInfo = encryptInfo;
            }
            const segments = streamSpec.playlist.mediaParts[0].mediaSegments;
            for (const segment of segments) {
              if (!segment.encryptInfo) segment.encryptInfo = encryptInfo;
            }
          }

          const _index = streamList.findIndex(
            (item) =>
              item.periodId !== streamSpec.periodId &&
              item.groupId === streamSpec.groupId &&
              item.resolution === streamSpec.resolution &&
              item.mediaType === streamSpec.mediaType,
          );
          if (_index > -1) {
            if (isLive) {
            } else {
              const url1 = streamList[_index]
                .playlist!.mediaParts.at(-1)!
                .mediaSegments.at(-1)!.url;
              const url2 = streamSpec.playlist.mediaParts[0].mediaSegments.at(-1)?.url;
              if (url1 !== url2) {
                const startIndex =
                  streamList[_index].playlist!.mediaParts.at(-1)!.mediaSegments.at(-1)!.index + 1;
                const segments = streamSpec.playlist.mediaParts[0].mediaSegments;
                for (const segment of segments) {
                  segment.index += startIndex;
                }
                const mediaPart = new MediaPart();
                mediaPart.mediaSegments = streamList[_index].playlist!.mediaParts[0].mediaSegments;
                streamList[_index].playlist!.mediaParts.push(mediaPart);
              } else {
                streamList[_index].playlist!.mediaParts.at(-1)!.mediaSegments.at(-1)!.duration +=
                  streamSpec.playlist.mediaParts[0].mediaSegments.reduce(
                    (sum, segment) => sum + segment.duration,
                    0,
                  );
              }
            }
          } else {
            if (streamSpec.mediaType === MEDIA_TYPES.SUBTITLES && streamSpec.extension === 'mp4') {
              streamSpec.extension = 'm4s';
            }
            if (
              streamSpec.mediaType !== MEDIA_TYPES.SUBTITLES &&
              (streamSpec.extension == null ||
                streamSpec.playlist.mediaParts.reduce(
                  (sum, part) => sum + part.mediaSegments.length,
                  0,
                ) > 1)
            ) {
              streamSpec.extension = 'm4s';
            }
            streamList.push(streamSpec);
          }

          segBaseUrl = representationsBaseUrl;
        }
        segBaseUrl = adaptationSetsBaseUrl;
      }
    }

    const audioList = streamList.filter((stream) => stream.mediaType === MEDIA_TYPES.AUDIO);
    const subtitleList = streamList.filter((stream) => stream.mediaType === MEDIA_TYPES.SUBTITLES);
    const videoList = streamList.filter((stream) => stream.mediaType === MEDIA_TYPES.VIDEO);

    for (const video of videoList) {
      const audioGroupId = audioList
        .toSorted((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
        .at(0)?.groupId;
      const subtitleGroupId = subtitleList
        .toSorted((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
        .at(0)?.groupId;
      if (audioGroupId) video.audioId = audioGroupId;
      if (subtitleGroupId) video.subtitleId = subtitleGroupId;
    }

    return streamList;
  }

  #filterLanguage(v?: string | null): string | undefined {
    if (!v) return;
    // const langCodeRegex = new RegExp('^[\w_\-\d]+$');
    // return langCodeRegex.test(v) ? v : 'und';
    return v;
  }

  async refreshPlayList(streamSpecs: StreamSpec[]): Promise<void> {
    if (!streamSpecs.length) return;

    const response = await fetch(this.#parserConfig.url, this.#parserConfig.headers).catch(() =>
      fetch(this.#parserConfig.originalUrl, this.#parserConfig.headers),
    );
    const rawText = await response.text();
    const url = response.url;

    this.#parserConfig.url = url;
    this.#setInitUrl();

    const newStreams = await this.extractStreams(rawText);
    for (const streamSpec of streamSpecs) {
      let results = newStreams.filter((n) => n.toShortString() === streamSpec.toShortString());
      if (!results.length) {
        results = newStreams.filter(
          (n) => n.playlist?.mediaInit?.url === streamSpec.playlist?.mediaInit?.url,
        );
      }
      if (results.length) {
        streamSpec.playlist!.mediaParts = results.at(0)!.playlist!.mediaParts;
      }
    }

    await this.#processUrl(streamSpecs);
  }

  async #processUrl(streamSpecs: StreamSpec[]): Promise<void> {
    for (const spec of streamSpecs) {
      const playlist = spec.playlist;
      if (!playlist) continue;
      if (playlist.mediaInit) {
        playlist.mediaInit.url = this.preProcessUrl(playlist.mediaInit.url);
      }
      for (const part of playlist.mediaParts) {
        for (const segment of part.mediaSegments) {
          segment.url = this.preProcessUrl(segment.url);
        }
      }
    }
  }

  async fetchPlayList(streamSpecs: StreamSpec[]): Promise<void> {
    this.#processUrl(streamSpecs);
  }

  preProcessUrl(url: string): string {
    for (const processor of this.#parserConfig.urlProcessors) {
      if (processor.canProcess(this.extractorType, url, this.#parserConfig)) {
        url = processor.process(url, this.#parserConfig);
      }
    }
    return url;
  }

  preProcessContent(): void {
    for (const processor of this.#parserConfig.contentProcessors) {
      if (processor.canProcess(this.extractorType, this.#mpdContent, this.#parserConfig)) {
        this.#mpdContent = processor.process(this.#mpdContent, this.#parserConfig);
      }
    }
  }
}
