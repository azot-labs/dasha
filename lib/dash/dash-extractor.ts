import { Temporal } from 'temporal-polyfill';
import { DOMParser, Element, LiveNodeList } from '@xmldom/xmldom';
import { EXTRACTOR_TYPES, ExtractorType } from '../shared/extractor-type';
import { ParserConfig } from '../parser-config';
import { ENCRYPT_METHODS, EncryptMethod } from '../shared/encrypt-method';
import {
  AudioStreamInfo,
  MediaStreamInfo,
  SubtitleStreamInfo,
  VideoStreamInfo,
} from '../shared/stream-info';
import { Extractor } from '../extractor';
import { combineUrl, replaceVars } from '../shared/util';
import { Playlist } from '../shared/playlist';
import { MediaPart } from '../shared/media-part';
import { ROLE_TYPE } from '../shared/role-type';
import { MediaSegment } from '../shared/media-segment';
import { DASH_TAGS } from './dash-tags';
import { EncryptInfo } from '../shared/encrypt-info';
import { parseRange } from './dash-utils';
import { parseDynamicRange, tryParseVideoCodec } from './dash-video';
import { checkIsClosedCaption, checkIsSdh, tryParseSubtitleCodec } from './dash-subtitle';
import {
  checkIsDescriptive,
  getDolbyDigitalPlusComplexityIndex,
  parseChannels,
  tryParseAudioCodec,
} from './dash-audio';
import { pipe } from '../shared/pipe';

const createMediaStreamInfo = (params: {
  codecs: string | null;
  contentType: string | null;
  mimeType: string | null;
}): MediaStreamInfo => {
  const shouldUseCodecsFromMime =
    params.contentType === 'text' && !params.mimeType?.includes('mp4');
  const codecs = shouldUseCodecsFromMime ? params.mimeType?.split('/')[1] : params.codecs;
  if (!params.codecs && codecs) params.codecs = codecs;

  if (params.codecs) {
    const videoCodec = tryParseVideoCodec(params.codecs);
    if (videoCodec) return new VideoStreamInfo({ codec: videoCodec });
    const audioCodec = tryParseAudioCodec(params.codecs);
    if (audioCodec) return new AudioStreamInfo({ codec: audioCodec });
    const subtitleCodec = tryParseSubtitleCodec(params.codecs);
    if (subtitleCodec) return new SubtitleStreamInfo({ codec: subtitleCodec });
  } else {
    const type = params.contentType || params.mimeType?.split('/')[0];
    if (type === 'video') return new VideoStreamInfo();
    if (type === 'audio') return new AudioStreamInfo();
    if (type === 'text') return new SubtitleStreamInfo();
  }

  throw new Error('Unable to determine the type of a track, cannot continue...');
};

const selectNonEmpty = (args: { tag: string; elements: Element[] }) => {
  for (const element of args.elements) {
    const results = element.getElementsByTagName(args.tag);
    if (results.length) return results;
  }
};

const toSchemeValueArray = (elements?: LiveNodeList<Element>) => {
  const results: { schemeIdUri: string; value?: string }[] = [];
  if (!elements) return results;
  for (const element of elements) {
    const schemeIdUri = element.getAttribute('schemeIdUri')!;
    const value = element.getAttribute('value')!;
    results.push({ schemeIdUri, value });
  }
  return results;
};

const getTagAttrs = (tag: string, ...elements: Element[]) => {
  const adapter = pipe(selectNonEmpty, toSchemeValueArray);
  return adapter({ tag, elements });
};

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
    const targets = node
      .getElementsByTagName('BaseURL')
      .filter((n) => !!n.parentNode?.isSameNode(node));
    const target = targets[0];
    if (target?.textContent) return combineUrl(baseUrl, target.textContent);
    return baseUrl;
  }

  #getFrameRate(node: Element): number | undefined {
    const frameRate = node.getAttribute('frameRate');
    if (!frameRate || !frameRate.includes('/')) return;
    const d = Number(frameRate.split('/')[0]) / Number(frameRate.split('/')[1]);
    return Number(d.toFixed(3));
  }

  async extractStreams(rawText: string): Promise<MediaStreamInfo[]> {
    const streamInfos: MediaStreamInfo[] = [];

    this.#mpdContent = rawText;

    const document = new DOMParser().parseFromString(this.#mpdContent, 'text/xml');
    const mpdElement = document.getElementsByTagName('MPD')[0];
    const type = mpdElement.getAttribute('type');
    const isLive = type === 'dynamic';

    // const maxSegmentDuration = mpdElement.getAttribute('maxSegmentDuration');
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
        let contentType = adaptationSet.getAttribute('contentType');
        let mimeType = adaptationSet.getAttribute('mimeType');
        const frameRate = this.#getFrameRate(adaptationSet);
        const representations = adaptationSet.getElementsByTagName('Representation');
        for (const representation of representations) {
          segBaseUrl = this.#extendBaseUrl(representation, segBaseUrl);

          if (!contentType) {
            contentType = representation.getAttribute('contentType');
          }
          if (!mimeType) {
            mimeType = representation.getAttribute('mimeType');
          }

          const codecs =
            representation.getAttribute('codecs') || adaptationSet.getAttribute('codecs')!;
          const widthParameterString = representation.getAttribute('width');
          const heightParameterString = representation.getAttribute('height');

          const roles = getTagAttrs('Role', representation, adaptationSet);
          const supplementalProps = getTagAttrs(
            'SupplementalProperty',
            representation,
            adaptationSet,
          );
          const essentialProps = getTagAttrs('EssentialProperty', representation, adaptationSet);
          const accessibilities = getTagAttrs('Accessibility', representation, adaptationSet);
          const audioChannelConfigs = getTagAttrs(
            'AudioChannelConfiguration',
            adaptationSet,
            representation,
          );
          const channelsString = audioChannelConfigs[0]?.value;

          const streamInfo = createMediaStreamInfo({ codecs, contentType, mimeType });

          const bitrate = Number(representation.getAttribute('bandwidth') ?? '');

          streamInfo.languageCode = this.#filterLanguage(
            representation.getAttribute('lang') || adaptationSet.getAttribute('lang'),
          );

          if (streamInfo.type === 'video') {
            streamInfo.bitrate = bitrate;
            streamInfo.width = Number(widthParameterString);
            streamInfo.height = Number(heightParameterString);
            streamInfo.frameRate = frameRate || this.#getFrameRate(representation);
            if (supplementalProps && essentialProps) {
              streamInfo.dynamicRange = parseDynamicRange(
                codecs,
                supplementalProps,
                essentialProps,
              );
            }
          } else if (streamInfo.type === 'audio') {
            streamInfo.bitrate = bitrate;
            if (accessibilities) {
              streamInfo.descriptive = checkIsDescriptive(accessibilities);
            }
            if (supplementalProps) {
              streamInfo.joc = getDolbyDigitalPlusComplexityIndex(supplementalProps);
            }
            if (channelsString) {
              streamInfo.numberOfChannels = parseChannels(channelsString);
              streamInfo.channels = channelsString;
            }
          } else if (streamInfo.type === 'subtitle') {
            streamInfo.bitrate = bitrate;
            if (roles) {
              streamInfo.cc = checkIsClosedCaption(roles);
            }
            if (accessibilities) {
              streamInfo.sdh = checkIsSdh(accessibilities);
            }
          }

          streamInfo.url = this.#mpdUrl;
          streamInfo.originalUrl = this.#parserConfig.originalUrl;
          streamInfo.playlist = new Playlist();
          streamInfo.playlist.mediaParts.push(new MediaPart());

          streamInfo.periodId = periodId;
          streamInfo.groupId = representation.getAttribute('id');
          streamInfo.codecs = codecs;

          const volumeAdjust = representation.getAttribute('volumeAdjust');
          if (volumeAdjust) {
            streamInfo.groupId = streamInfo.groupId + '-' + volumeAdjust;
          }

          const mType =
            representation.getAttribute('mimeType') || adaptationSet.getAttribute('mimeType');
          if (mType) {
            const mTypeSplit = mType.split('/');
            streamInfo.extension = mTypeSplit.length === 2 ? mTypeSplit[1] : null;
          }

          const role = roles?.[0];
          if (role) {
            const roleValue = role.value;
            const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
            const roleTypeKey = roleValue!.split('-').map(capitalize).join('');
            const roleType = ROLE_TYPE[roleTypeKey as keyof typeof ROLE_TYPE];
            streamInfo.role = roleType;
            // if (roleType === ROLE_TYPE.Subtitle) {
            //   streamInfo.type = 'subtitle';
            //   if (mType?.includes('ttml')) streamInfo.extension = 'ttml';
            // } else if (roleType === ROLE_TYPE.ForcedSubtitle) {
            //   streamInfo.type = 'subtitle';
            // }
          }

          streamInfo.playlist.isLive = isLive;

          if (timeShiftBufferDepth) {
            streamInfo.playlist.refreshIntervalMs =
              Temporal.Duration.from(timeShiftBufferDepth).total('milliseconds') / 2;
          }

          if (publishTime) {
            streamInfo.publishTime = new Date(publishTime);
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
                streamInfo.playlist.mediaParts[0].mediaSegments.push(mediaSegment);
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
                streamInfo.playlist.mediaInit = initSegment;
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
              streamInfo.playlist.mediaInit = initSegment;
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
              streamInfo.playlist.mediaParts[0].mediaSegments.push(segment);
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
            varDic[DASH_TAGS.TemplateRepresentationID] = streamInfo.groupId;
            varDic[DASH_TAGS.TemplateBandwidth] = bitrate;
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
              streamInfo.playlist.mediaInit = mediaSegment;
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
                streamInfo.playlist.mediaParts[0].mediaSegments.push(mediaSegment);
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
                  streamInfo.playlist.mediaParts[0].mediaSegments.push(_mediaSegment);
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
                streamInfo.playlist.mediaParts[0].mediaSegments.push(mediaSegment);
              }
            }
          }

          if (streamInfo.playlist.mediaParts[0].mediaSegments.length === 0) {
            const mediaSegment = new MediaSegment();
            mediaSegment.index = 0;
            mediaSegment.url = segBaseUrl;
            mediaSegment.duration = periodDurationSeconds;
            streamInfo.playlist.mediaParts[0].mediaSegments.push(mediaSegment);
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

            const widevineSystemId = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
            const playreadySystemId = '9a04f079-9840-4286-ab92-e65be0885f95';
            for (const contentProtection of contentProtections) {
              const schemeIdUri = contentProtection.getAttribute('schemeIdUri');
              const defaultKID = contentProtection.getAttribute('cenc:default_KID') || undefined;
              const pssh =
                contentProtection.getElementsByTagName('cenc:pssh')[0]?.textContent || undefined;
              const drmData = { keyId: defaultKID, pssh: pssh };
              if (schemeIdUri?.includes(widevineSystemId)) {
                encryptInfo.drm.widevine = drmData;
              } else if (schemeIdUri?.includes(playreadySystemId)) {
                encryptInfo.drm.playready = drmData;
              } else {
                continue;
              }
            }

            if (streamInfo.playlist.mediaInit) {
              streamInfo.playlist.mediaInit.encryptInfo = encryptInfo;
            }
            const segments = streamInfo.playlist.mediaParts[0].mediaSegments;
            for (const segment of segments) {
              if (!segment.encryptInfo) segment.encryptInfo = encryptInfo;
            }
          }

          const _index = streamInfos.findIndex(
            (item) =>
              item.type === streamInfo.type &&
              item.periodId !== streamInfo.periodId &&
              item.groupId === streamInfo.groupId &&
              (item.type === 'video' && streamInfo.type === 'video'
                ? item.width === streamInfo.width && item.height === streamInfo.height
                : true),
          );
          if (_index > -1) {
            if (isLive) {
            } else {
              const url1 = streamInfos[_index]
                .playlist!.mediaParts.at(-1)!
                .mediaSegments.at(-1)!.url;
              const url2 = streamInfo.playlist.mediaParts[0].mediaSegments.at(-1)?.url;
              if (url1 !== url2) {
                const startIndex =
                  streamInfos[_index].playlist!.mediaParts.at(-1)!.mediaSegments.at(-1)!.index + 1;
                const segments = streamInfo.playlist.mediaParts[0].mediaSegments;
                for (const segment of segments) {
                  segment.index += startIndex;
                }
                const mediaPart = new MediaPart();
                mediaPart.mediaSegments = streamInfos[_index].playlist!.mediaParts[0].mediaSegments;
                streamInfos[_index].playlist!.mediaParts.push(mediaPart);
              } else {
                streamInfos[_index].playlist!.mediaParts.at(-1)!.mediaSegments.at(-1)!.duration +=
                  streamInfo.playlist.mediaParts[0].mediaSegments.reduce(
                    (sum, segment) => sum + segment.duration,
                    0,
                  );
              }
            }
          } else {
            if (streamInfo.type === 'subtitle' && streamInfo.extension === 'mp4') {
              streamInfo.extension = 'm4s';
            }
            if (
              streamInfo.type !== 'subtitle' &&
              (streamInfo.extension == null ||
                streamInfo.playlist.mediaParts.reduce(
                  (sum, part) => sum + part.mediaSegments.length,
                  0,
                ) > 1)
            ) {
              streamInfo.extension = 'm4s';
            }
            streamInfos.push(streamInfo);
          }

          segBaseUrl = representationsBaseUrl;
        }
        segBaseUrl = adaptationSetsBaseUrl;
      }
    }

    const audioList = streamInfos.filter((stream) => stream.type === 'audio');
    const subtitleList = streamInfos.filter((stream) => stream.type === 'subtitle');
    const videoList = streamInfos.filter((stream) => stream.type === 'video');

    for (const video of videoList) {
      const audioGroupId = audioList
        .toSorted((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
        .at(0)?.groupId;
      const subtitleGroupId = subtitleList
        .toSorted((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
        .at(0)?.groupId;
      if (audioGroupId) video.audioId = audioGroupId;
      if (subtitleGroupId) video.subtitleId = subtitleGroupId;
    }

    return streamInfos;
  }

  #filterLanguage(v?: string | null): string | undefined {
    if (!v) return;
    // const langCodeRegex = new RegExp('^[\w_\-\d]+$');
    // return langCodeRegex.test(v) ? v : 'und';
    return v;
  }

  async refreshPlayList(streamInfos: MediaStreamInfo[]): Promise<void> {
    if (!streamInfos.length) return;

    const response = await fetch(this.#parserConfig.url, this.#parserConfig.headers).catch(() =>
      fetch(this.#parserConfig.originalUrl, this.#parserConfig.headers),
    );
    const rawText = await response.text();
    const url = response.url;

    this.#parserConfig.url = url;
    this.#setInitUrl();

    const newStreams = await this.extractStreams(rawText);
    for (const streamInfo of streamInfos) {
      let results = newStreams.filter((n) => n.toShortString() === streamInfo.toShortString());
      if (!results.length) {
        results = newStreams.filter(
          (n) => n.playlist?.mediaInit?.url === streamInfo.playlist?.mediaInit?.url,
        );
      }
      if (results.length) {
        streamInfo.playlist!.mediaParts = results.at(0)!.playlist!.mediaParts;
      }
    }

    await this.#processUrl(streamInfos);
  }

  async #processUrl(streamInfos: MediaStreamInfo[]): Promise<void> {
    for (const spec of streamInfos) {
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

  async fetchPlayList(streamInfos: MediaStreamInfo[]): Promise<void> {
    this.#processUrl(streamInfos);
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
