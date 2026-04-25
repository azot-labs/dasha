import { DOMParser } from '@xmldom/xmldom';
import { InputFormat } from 'mediabunny';
import type {
  AudioCodec,
  EncodedPacket,
  Input as MediabunnyInput,
  MediaCodec,
  MetadataTags,
  PacketType,
  Source,
  TrackDisposition,
  VideoCodec,
} from 'mediabunny';
import { Temporal } from 'temporal-polyfill';
import {
  checkIsDescriptive,
  getDolbyDigitalPlusComplexityIndex,
  parseChannels,
} from '../shared/audio';
import { EncryptInfo } from '../shared/encrypt-info';
import { ENCRYPT_METHODS } from '../shared/encrypt-method';
import type { EncryptMethod } from '../shared/encrypt-method';
import { MediaPart } from '../shared/media-part';
import { MediaSegment } from '../shared/media-segment';
import { Playlist } from '../shared/playlist';
import { ROLE_TYPE } from '../shared/role-type';
import { checkIsClosedCaption, checkIsSdh } from '../shared/subtitle';
import type {
  AudioStreamInfo,
  MediaStreamInfo,
  SubtitleStreamInfo,
  VideoStreamInfo,
} from '../shared/stream-info';
import { combineUrl, replaceVars } from '../shared/util';
import { parseDynamicRange } from '../shared/video';
import {
  DashSegmentedInput,
  playlistToDashSegments,
  type DashSegment,
  type DashSegmentSource,
} from './dash-segmented-input';
import { DASH_TAGS } from './dash-tags';
import { parseRange } from './dash-utils';
import {
  createDashStreamInfo,
  DASH_MIME_TYPE,
  extendDashBaseUrl,
  filterDashLanguage,
  getDashFrameRate,
  getDashTagAttrs,
  getSourceHeaders,
  isDashManifestText,
  isLikelyDashPath,
  loadDashManifest,
} from './dash-misc';

export type { DashSegment } from './dash-segmented-input';
export { DashSegmentedInput } from './dash-segmented-input';

const DASH_NAMESPACE_MAP = new Map([
  ['cenc', 'urn:mpeg:cenc:2013'],
  ['mspr', 'urn:microsoft:playready'],
  ['mas', 'urn:marlin:mas:1-0:services:schemas:mpd'],
]);

const isMissingNamespace = (rawText: string, tag: string) =>
  !rawText.includes(`xmlns:${tag}`) && rawText.includes(`<${tag}:`);

const replaceFirst = (source: string, oldValue: string, newValue: string) => {
  const index = source.indexOf(oldValue);
  return index < 0
    ? source
    : source.slice(0, index) + newValue + source.slice(index + oldValue.length);
};

const processDashContent = (mpdContent: string) => {
  const missingNamespaceKeys = Array.from(
    DASH_NAMESPACE_MAP.keys().filter((key) => isMissingNamespace(mpdContent, key)),
  );
  if (!missingNamespaceKeys.length) return mpdContent;

  const missingNamespaceDfns = missingNamespaceKeys.map(
    (key) => `xmlns:${key}="${DASH_NAMESPACE_MAP.get(key)}"`,
  );
  return replaceFirst(mpdContent, '<MPD ', `<MPD ${missingNamespaceDfns.join(' ')} `);
};

type DashManifestContext = {
  url: string;
  originalUrl: string;
  headers: Record<string, string>;
};

class DashManifestParser {
  static #DEFAULT_METHOD: EncryptMethod = ENCRYPT_METHODS.CENC;

  #mpdUrl = '';
  #baseUrl = '';
  #mpdContent = '';
  #context: DashManifestContext;

  constructor(context: DashManifestContext) {
    this.#context = context;
    this.#setInitUrl();
  }

  #setInitUrl() {
    this.#mpdUrl = this.#context.url;
    this.#baseUrl = this.#mpdUrl;
  }

  async extractStreams(rawText: string): Promise<MediaStreamInfo[]> {
    const streamInfos: MediaStreamInfo[] = [];

    this.#mpdContent = processDashContent(rawText);

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
      let segBaseUrl = extendDashBaseUrl(period, this.#baseUrl);
      const adaptationSetsBaseUrl = segBaseUrl;
      const adaptationSets = period.getElementsByTagName('AdaptationSet');
      for (const adaptationSet of adaptationSets) {
        segBaseUrl = extendDashBaseUrl(adaptationSet, segBaseUrl);
        const representationsBaseUrl = segBaseUrl;
        let contentType = adaptationSet.getAttribute('contentType');
        let mimeType = adaptationSet.getAttribute('mimeType');
        const frameRate = getDashFrameRate(adaptationSet);
        const representations = adaptationSet.getElementsByTagName('Representation');
        for (const representation of representations) {
          segBaseUrl = extendDashBaseUrl(representation, segBaseUrl);

          if (!contentType) {
            contentType = representation.getAttribute('contentType');
          }
          if (!mimeType) {
            mimeType = representation.getAttribute('mimeType');
          }

          const codecs =
            representation.getAttribute('codecs') || adaptationSet.getAttribute('codecs');
          const widthParameterString = representation.getAttribute('width');
          const heightParameterString = representation.getAttribute('height');

          const roles = getDashTagAttrs('Role', representation, adaptationSet);
          const supplementalProps = getDashTagAttrs(
            'SupplementalProperty',
            representation,
            adaptationSet,
          );
          const essentialProps = getDashTagAttrs(
            'EssentialProperty',
            representation,
            adaptationSet,
          );
          const accessibilities = getDashTagAttrs('Accessibility', representation, adaptationSet);
          const audioChannelConfigs = getDashTagAttrs(
            'AudioChannelConfiguration',
            adaptationSet,
            representation,
          );
          const channelsString = audioChannelConfigs[0]?.value;

          const streamInfo = createDashStreamInfo({ codecs, contentType, mimeType });

          const bitrate = Number(representation.getAttribute('bandwidth') ?? '');

          streamInfo.languageCode = filterDashLanguage(
            representation.getAttribute('lang') || adaptationSet.getAttribute('lang'),
          );

          if (streamInfo.type === 'video') {
            streamInfo.bitrate = bitrate;
            streamInfo.width = Number(widthParameterString);
            streamInfo.height = Number(heightParameterString);
            streamInfo.frameRate = frameRate || getDashFrameRate(representation);
            if (codecs && supplementalProps && essentialProps) {
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
          streamInfo.originalUrl = this.#context.originalUrl;
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
          if (role?.value) {
            const roleValue = role.value;
            const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
            const roleTypeKey = roleValue.split('-').map(capitalize).join('');
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
              const sourceUrl = initialization.getAttribute('sourceURL');
              if (sourceUrl) {
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

            const segmentUrls = segmentList.getElementsByTagName('SegmentURL');
            const timescaleStr = segmentList.getAttribute('timescale') || '1';
            for (let segmentIndex = 0; segmentIndex < segmentUrls.length; segmentIndex++) {
              const segmentUrl = segmentUrls[segmentIndex];
              const media = segmentUrl.getAttribute('media');
              if (!media) continue;
              const mediaUrl = combineUrl(segBaseUrl, media);
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
            const varDic: Record<string, string> = {};
            varDic[DASH_TAGS.TemplateRepresentationID] = streamInfo.groupId ?? '';
            varDic[DASH_TAGS.TemplateBandwidth] = String(bitrate);
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
            if (!mediaTemplate) {
              // SegmentTemplate can legally provide only initialization data; fallback handling below
              // will create a whole-resource segment when no media segments were emitted.
            } else if (segmentTimeline) {
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
                varDic[DASH_TAGS.TemplateTime] = String(currentTime);
                varDic[DASH_TAGS.TemplateNumber] = String(segNumber++);
                const hasTime = mediaTemplate.includes(DASH_TAGS.TemplateTime);
                const media = replaceVars(mediaTemplate, varDic);
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
                  varDic[DASH_TAGS.TemplateTime] = String(currentTime);
                  varDic[DASH_TAGS.TemplateNumber] = String(segNumber++);
                  const _hashTime = mediaTemplate.includes(DASH_TAGS.TemplateTime);
                  const _media = replaceVars(mediaTemplate, varDic);
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
                if (!availabilityStartTime) {
                  throw new Error('Invalid live MPD: availabilityStartTime is required.');
                }
                const now = Date.now();
                const availableTime = new Date(availabilityStartTime);
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
                varDic[DASH_TAGS.TemplateNumber] = String(index);
                const hasNumber = mediaTemplate.includes(DASH_TAGS.TemplateNumber);
                const media = replaceVars(mediaTemplate, varDic);
                const mediaUrl = combineUrl(segBaseUrl, media);
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
            encryptInfo.method = DashManifestParser.#DEFAULT_METHOD;

            const widevineSystemId = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
            const playreadySystemId = '9a04f079-9840-4286-ab92-e65be0885f95';
            for (const contentProtection of contentProtections) {
              const schemeIdUri = contentProtection.getAttribute('schemeIdUri');
              const defaultKID = contentProtection.getAttribute('cenc:default_KID') || undefined;
              const pssh =
                contentProtection.getElementsByTagName('cenc:pssh')[0]?.textContent || undefined;
              const drmData = { keyId: defaultKID, pssh: pssh?.trim() };
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
              if (!segment.encryptInfo || segment.encryptInfo.method === 'unknown')
                segment.encryptInfo = encryptInfo;
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
              const existingPlaylist = streamInfos[_index].playlist;
              const lastPart = existingPlaylist?.mediaParts.at(-1);
              const lastSegment = lastPart?.mediaSegments.at(-1);
              if (!existingPlaylist || !lastPart || !lastSegment) {
                continue;
              }

              const url1 = lastSegment.url;
              const url2 = streamInfo.playlist.mediaParts[0].mediaSegments.at(-1)?.url;
              if (url1 !== url2) {
                const startIndex = lastSegment.index + 1;
                const segments = streamInfo.playlist.mediaParts[0].mediaSegments;
                for (const segment of segments) {
                  segment.index += startIndex;
                }
                const mediaPart = new MediaPart();
                mediaPart.mediaSegments = streamInfo.playlist.mediaParts[0].mediaSegments;
                existingPlaylist.mediaParts.push(mediaPart);
              } else {
                lastSegment.duration += streamInfo.playlist.mediaParts[0].mediaSegments.reduce(
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

  get manifestUrl() {
    return this.#context.url;
  }

  async refreshPlayList(streamInfos: MediaStreamInfo[]): Promise<void> {
    if (!streamInfos.length) return;

    const response = await this.#fetchManifest(this.#context.url).catch(() =>
      this.#fetchManifest(this.#context.originalUrl),
    );
    const rawText = await response.text();

    this.#context.url = response.url;
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
        const resultPlaylist = results[0]?.playlist;
        if (streamInfo.playlist && resultPlaylist) {
          streamInfo.playlist.mediaParts = resultPlaylist.mediaParts;
        }
      }
    }
  }

  async #fetchManifest(url: string) {
    const response = await fetch(url, { headers: this.#context.headers });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch DASH manifest: ${response.status} ${response.statusText} (${response.url})`,
      );
    }
    return response;
  }
}

const DEFAULT_DISPOSITION: TrackDisposition = {
  default: true,
  primary: true,
  forced: false,
  original: false,
  commentary: false,
  hearingImpaired: false,
  visuallyImpaired: false,
};

const getDisposition = (streamInfo: MediaStreamInfo): TrackDisposition => {
  const subtitleStreamInfo =
    streamInfo.type === 'subtitle' ? (streamInfo as SubtitleStreamInfo) : undefined;
  const audioStreamInfo = streamInfo.type === 'audio' ? (streamInfo as AudioStreamInfo) : undefined;

  return {
    ...DEFAULT_DISPOSITION,
    default: !!streamInfo.default,
    commentary: streamInfo.role === ROLE_TYPE.Commentary,
    hearingImpaired: !!subtitleStreamInfo?.sdh,
    visuallyImpaired: !!audioStreamInfo?.descriptive,
    forced: streamInfo.role === ROLE_TYPE.ForcedSubtitle || !!subtitleStreamInfo?.forced,
  };
};

const canPairStreams = (left: MediaStreamInfo, right: MediaStreamInfo) => {
  if (left === right || left.type === right.type) return false;

  if (left.type === 'video' && right.type === 'audio') {
    return !left.audioId || left.audioId === right.groupId;
  }

  if (left.type === 'audio' && right.type === 'video') {
    return !right.audioId || right.audioId === left.groupId;
  }

  if (left.type === 'video' && right.type === 'subtitle') {
    return !left.subtitleId || left.subtitleId === right.groupId;
  }

  if (left.type === 'subtitle' && right.type === 'video') {
    return !right.subtitleId || right.subtitleId === left.groupId;
  }

  return false;
};

const createPairingMasks = (streams: MediaStreamInfo[]) => {
  const masks = new Map<MediaStreamInfo, bigint>();
  let nextPairIndex = 0;

  for (const [leftIndex, left] of streams.entries()) {
    for (const right of streams.slice(leftIndex + 1)) {
      if (!canPairStreams(left, right)) continue;

      const bit = 1n << BigInt(nextPairIndex++);
      masks.set(left, (masks.get(left) ?? 0n) | bit);
      masks.set(right, (masks.get(right) ?? 0n) | bit);
    }
  }

  return masks;
};

type LoadedDashSession = {
  parser: DashManifestParser;
  streams: MediaStreamInfo[];
  trackBackings: DashInputTrackBacking[];
};

class DashSession {
  readonly source: Source;

  #loadPromise?: Promise<LoadedDashSession>;
  #disposed = false;

  constructor(source: Source) {
    this.source = source;
  }

  async load(): Promise<LoadedDashSession> {
    if (this.#disposed) {
      throw new Error('Input has been disposed.');
    }

    this.#loadPromise ??= (async () => {
      const { text, url } = await loadDashManifest(this.source);
      const parser = new DashManifestParser({
        headers: getSourceHeaders(this.source),
        originalUrl: url,
        url,
      });
      const streams = await parser.extractStreams(text.trim());

      const typeNumbers = {
        video: 1,
        audio: 1,
        subtitle: 1,
      };
      const pairingMasks = createPairingMasks(streams);
      const trackBackings: DashInputTrackBacking[] = [];

      for (const [index, stream] of streams.entries()) {
        const number = typeNumbers[stream.type]++;
        const pairingMask = pairingMasks.get(stream) ?? 0n;

        if (stream.type === 'video') {
          trackBackings.push(
            new DashInputVideoTrackBacking(this, stream, index + 1, number, pairingMask),
          );
        } else if (stream.type === 'audio') {
          trackBackings.push(
            new DashInputAudioTrackBacking(this, stream, index + 1, number, pairingMask),
          );
        } else if (stream.type === 'subtitle') {
          trackBackings.push(
            new DashInputSubtitleTrackBacking(this, stream, index + 1, number, pairingMask),
          );
        }
      }

      return {
        parser,
        streams,
        trackBackings,
      };
    })();

    return this.#loadPromise;
  }

  async refreshSegments(streamInfo: MediaStreamInfo): Promise<void> {
    const { parser, streams } = await this.load();
    if (!streamInfo.playlist?.isLive) return;
    if (!parser.manifestUrl.startsWith('http://') && !parser.manifestUrl.startsWith('https://'))
      return;

    await parser.refreshPlayList(streams);
  }

  dispose() {
    this.#disposed = true;
  }
}

abstract class DashTrackBacking implements DashSegmentSource {
  readonly session: DashSession;
  readonly streamInfo: MediaStreamInfo;

  #segmentedInput?: DashSegmentedInput;

  constructor(
    session: DashSession,
    streamInfo: MediaStreamInfo,
    private readonly id: number,
    private readonly number: number,
    private readonly pairingMask: bigint,
  ) {
    this.session = session;
    this.streamInfo = streamInfo;
  }

  abstract getType(): 'video' | 'audio' | 'subtitle';

  getId() {
    return this.id;
  }

  getNumber() {
    return this.number;
  }

  getCodec(): MediaCodec | null {
    return this.streamInfo.codec as MediaCodec | null;
  }

  getInternalCodecId() {
    return null;
  }

  getName() {
    return this.streamInfo.name ?? null;
  }

  getLanguageCode() {
    return this.streamInfo.languageCode ?? 'und';
  }

  getTimeResolution() {
    return 1;
  }

  isRelativeToUnixEpoch() {
    return false;
  }

  getDisposition() {
    return getDisposition(this.streamInfo);
  }

  getPairingMask() {
    return this.pairingMask;
  }

  getBitrate() {
    return this.streamInfo.bitrate ?? null;
  }

  getAverageBitrate() {
    return this.streamInfo.bitrate ?? null;
  }

  async getDurationFromMetadata() {
    return this.streamInfo.playlist?.totalDuration ?? null;
  }

  async getLiveRefreshInterval() {
    if (!this.streamInfo.playlist?.isLive) return null;
    return this.streamInfo.playlist.refreshIntervalMs / 1000;
  }

  async refreshSegments(streamInfo: MediaStreamInfo) {
    await this.session.refreshSegments(streamInfo);
  }

  getHasOnlyKeyPackets() {
    return false;
  }

  async getDecoderConfig() {
    return null;
  }

  getMetadataCodecParameterString() {
    return this.streamInfo.codecs;
  }

  async getFirstPacket() {
    return null;
  }

  async getPacket() {
    return null;
  }

  async getNextPacket(_packet: EncodedPacket) {
    return null;
  }

  async getKeyPacket() {
    return null;
  }

  async getNextKeyPacket(_packet: EncodedPacket) {
    return null;
  }

  getSegmentedInput() {
    this.#segmentedInput ??= new DashSegmentedInput(this);
    return this.#segmentedInput;
  }

  async getSegments() {
    const segmentedInput = this.getSegmentedInput();
    await segmentedInput.runUpdateSegments();
    return segmentedInput.segments;
  }

  toSegments() {
    return playlistToDashSegments(this.streamInfo.playlist);
  }
}

class DashInputVideoTrackBacking extends DashTrackBacking {
  override streamInfo: VideoStreamInfo;

  constructor(
    session: DashSession,
    streamInfo: VideoStreamInfo,
    id: number,
    number: number,
    pairingMask: bigint,
  ) {
    super(session, streamInfo, id, number, pairingMask);
    this.streamInfo = streamInfo;
  }

  getType() {
    return 'video' as const;
  }

  override getCodec(): VideoCodec | null {
    return this.streamInfo.codec as VideoCodec | null;
  }

  getCodedWidth() {
    return this.streamInfo.width ?? 0;
  }

  getCodedHeight() {
    return this.streamInfo.height ?? 0;
  }

  getSquarePixelWidth() {
    return this.streamInfo.width ?? 0;
  }

  getSquarePixelHeight() {
    return this.streamInfo.height ?? 0;
  }

  getRotation() {
    return 0;
  }

  async getColorSpace(): Promise<VideoColorSpaceInit> {
    return {};
  }

  async canBeTransparent() {
    return false;
  }
}

class DashInputAudioTrackBacking extends DashTrackBacking {
  override streamInfo: AudioStreamInfo;

  constructor(
    session: DashSession,
    streamInfo: AudioStreamInfo,
    id: number,
    number: number,
    pairingMask: bigint,
  ) {
    super(session, streamInfo, id, number, pairingMask);
    this.streamInfo = streamInfo;
  }

  getType() {
    return 'audio' as const;
  }

  override getCodec(): AudioCodec | null {
    return this.streamInfo.codec as AudioCodec | null;
  }

  getNumberOfChannels() {
    return this.streamInfo.numberOfChannels ?? 0;
  }

  getSampleRate() {
    return this.streamInfo.sampleRate ?? 0;
  }
}

class DashInputSubtitleTrackBacking extends DashTrackBacking {
  override streamInfo: SubtitleStreamInfo;

  constructor(
    session: DashSession,
    streamInfo: SubtitleStreamInfo,
    id: number,
    number: number,
    pairingMask: bigint,
  ) {
    super(session, streamInfo, id, number, pairingMask);
    this.streamInfo = streamInfo;
  }

  getType() {
    return 'subtitle' as const;
  }
}

export type DashInputTrackBacking =
  | DashInputVideoTrackBacking
  | DashInputAudioTrackBacking
  | DashInputSubtitleTrackBacking;

class DashDemuxer {
  input: MediabunnyInput;

  #session: DashSession;

  constructor(input: MediabunnyInput) {
    this.input = input;
    this.#session = new DashSession(input.source);
  }

  async getTrackBackings() {
    const { trackBackings } = await this.#session.load();
    return trackBackings;
  }

  async getMimeType() {
    return DASH.mimeType;
  }

  async getMetadataTags(): Promise<MetadataTags> {
    return {};
  }

  dispose() {
    this.#session.dispose();
  }
}

export class DashInputFormat extends InputFormat {
  get name() {
    return 'dash';
  }

  get mimeType() {
    return DASH_MIME_TYPE;
  }

  async _canReadInput(input: MediabunnyInput) {
    if (isLikelyDashPath(input.source)) return true;

    try {
      const { text } = await loadDashManifest(input.source);
      return isDashManifestText(text);
    } catch {
      return false;
    }
  }

  _createDemuxer(input: MediabunnyInput) {
    return new DashDemuxer(input);
  }
}

export type DashInputSubtitleTrack = {
  readonly type: 'subtitle';
  getCodec(): Promise<MediaCodec | null>;
  getCodecParameterString(): Promise<string | null>;
  getSegmentedInput(): DashSegmentedInput;
  getSegments(): Promise<DashSegment[]>;
  isVideoTrack(): false;
  isAudioTrack(): false;
  determinePacketType(packet: EncodedPacket): Promise<PacketType | null>;
};

export const DASH = new DashInputFormat();
export const DASH_FORMATS: InputFormat[] = [DASH];
