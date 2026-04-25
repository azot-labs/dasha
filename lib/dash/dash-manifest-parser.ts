import { DOMParser, type Element } from '@xmldom/xmldom';
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
import type { MediaStreamInfo } from '../shared/stream-info';
import { combineUrl, replaceVars } from '../shared/util';
import { parseDynamicRange } from '../shared/video';
import { DASH_TAGS } from './dash-tags';
import { parseRange } from './dash-utils';
import {
  createDashStreamInfo,
  extendDashBaseUrl,
  filterDashLanguage,
  getDashFrameRate,
  getDashTagAttrs,
} from './dash-misc';

export type DashManifestContext = {
  url: string;
  originalUrl: string;
  headers: Record<string, string>;
};

const DASH_NAMESPACE_MAP = new Map([
  ['cenc', 'urn:mpeg:cenc:2013'],
  ['mspr', 'urn:microsoft:playready'],
  ['mas', 'urn:marlin:mas:1-0:services:schemas:mpd'],
]);

const WIDEVINE_SYSTEM_ID = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const PLAYREADY_SYSTEM_ID = '9a04f079-9840-4286-ab92-e65be0885f95';

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

  const missingNamespaceDefinitions = missingNamespaceKeys.map(
    (key) => `xmlns:${key}="${DASH_NAMESPACE_MAP.get(key)}"`,
  );
  return replaceFirst(mpdContent, '<MPD ', `<MPD ${missingNamespaceDefinitions.join(' ')} `);
};

const getPrimaryMediaPart = (playlist: Playlist) => {
  const mediaPart = playlist.mediaParts[0];
  if (!mediaPart) {
    throw new Error('DASH playlist must have a primary media part.');
  }
  return mediaPart;
};

const getMediaSegments = (playlist: Playlist) => getPrimaryMediaPart(playlist).mediaSegments;

const addWholeResourceSegment = (playlist: Playlist, url: string, duration: number) => {
  const mediaSegment = new MediaSegment();
  mediaSegment.index = 0;
  mediaSegment.url = url;
  mediaSegment.duration = duration;
  getMediaSegments(playlist).push(mediaSegment);
};

const createRangedSegment = (url: string, index: number, range?: string | null) => {
  const segment = new MediaSegment();
  segment.index = index;
  segment.url = url;

  if (range) {
    const [start, expect] = parseRange(range);
    segment.startRange = start;
    segment.expectLength = expect;
  }

  return segment;
};

const createPlaylist = (isLive: boolean, timeShiftBufferDepth: string) => {
  const playlist = new Playlist();
  playlist.isLive = isLive;
  playlist.mediaParts.push(new MediaPart());
  playlist.refreshIntervalMs =
    Temporal.Duration.from(timeShiftBufferDepth).total('milliseconds') / 2;
  return playlist;
};

const getRoleType = (roleValue: string) => {
  const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  const roleTypeKey = roleValue.split('-').map(capitalize).join('');
  return ROLE_TYPE[roleTypeKey as keyof typeof ROLE_TYPE];
};

const applyTrackMetadata = (params: {
  adaptationSet: Element;
  bitrate: number;
  frameRate: number | undefined;
  period: Element;
  playlist: Playlist;
  publishTime: string | null;
  representation: Element;
  streamInfo: MediaStreamInfo;
}) => {
  const {
    adaptationSet,
    bitrate,
    frameRate,
    period,
    playlist,
    publishTime,
    representation,
    streamInfo,
  } = params;
  const roles = getDashTagAttrs('Role', representation, adaptationSet);
  const supplementalProps = getDashTagAttrs('SupplementalProperty', representation, adaptationSet);
  const essentialProps = getDashTagAttrs('EssentialProperty', representation, adaptationSet);
  const accessibilities = getDashTagAttrs('Accessibility', representation, adaptationSet);
  const audioChannelConfigs = getDashTagAttrs(
    'AudioChannelConfiguration',
    adaptationSet,
    representation,
  );
  const codecs = representation.getAttribute('codecs') || adaptationSet.getAttribute('codecs');
  const width = representation.getAttribute('width');
  const height = representation.getAttribute('height');
  const channelsString = audioChannelConfigs[0]?.value;

  streamInfo.languageCode = filterDashLanguage(
    representation.getAttribute('lang') || adaptationSet.getAttribute('lang'),
  );
  streamInfo.bitrate = bitrate;
  streamInfo.playlist = playlist;
  streamInfo.periodId = period.getAttribute('id');
  streamInfo.groupId = representation.getAttribute('id');
  streamInfo.codecs = codecs;

  const volumeAdjust = representation.getAttribute('volumeAdjust');
  if (volumeAdjust) {
    streamInfo.groupId = `${streamInfo.groupId}-${volumeAdjust}`;
  }

  const mimeType =
    representation.getAttribute('mimeType') || adaptationSet.getAttribute('mimeType');
  if (mimeType) {
    const mimeTypeSplit = mimeType.split('/');
    streamInfo.extension = mimeTypeSplit.length === 2 ? mimeTypeSplit[1] : null;
  }

  if (streamInfo.type === 'video') {
    streamInfo.width = Number(width);
    streamInfo.height = Number(height);
    streamInfo.frameRate = frameRate || getDashFrameRate(representation);
    if (codecs && supplementalProps && essentialProps) {
      streamInfo.dynamicRange = parseDynamicRange(codecs, supplementalProps, essentialProps);
    }
  } else if (streamInfo.type === 'audio') {
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
    if (roles) {
      streamInfo.cc = checkIsClosedCaption(roles);
    }
    if (accessibilities) {
      streamInfo.sdh = checkIsSdh(accessibilities);
    }
  }

  const role = roles[0];
  if (role?.value) {
    streamInfo.role = getRoleType(role.value);
  }

  if (publishTime) {
    streamInfo.publishTime = new Date(publishTime);
  }
};

const normalizeStreamExtension = (streamInfo: MediaStreamInfo, playlist: Playlist) => {
  if (streamInfo.type === 'subtitle' && streamInfo.extension === 'mp4') {
    streamInfo.extension = 'm4s';
  }

  if (
    streamInfo.type !== 'subtitle' &&
    (streamInfo.extension == null || getMediaSegments(playlist).length > 1)
  ) {
    streamInfo.extension = 'm4s';
  }
};

const applySegmentBase = (representation: Element, playlist: Playlist, segBaseUrl: string) => {
  const segmentBaseElement = representation.getElementsByTagName('SegmentBase')[0];
  if (!segmentBaseElement) return;

  const initialization = segmentBaseElement.getElementsByTagName('Initialization')[0];
  if (!initialization) return;

  const sourceUrl = initialization.getAttribute('sourceURL');
  if (!sourceUrl) return;

  const initSegment = createRangedSegment(
    combineUrl(segBaseUrl, sourceUrl),
    -1,
    initialization.getAttribute('range'),
  );
  playlist.mediaInit = initSegment;
};

const applySegmentList = (representation: Element, playlist: Playlist, segBaseUrl: string) => {
  const segmentList = representation.getElementsByTagName('SegmentList')[0];
  if (!segmentList) return;

  const initialization = segmentList.getElementsByTagName('Initialization')[0];
  if (initialization) {
    const sourceUrl = initialization.getAttribute('sourceURL');
    if (sourceUrl) {
      playlist.mediaInit = createRangedSegment(
        combineUrl(segBaseUrl, sourceUrl),
        -1,
        initialization.getAttribute('range'),
      );
    }
  }

  const duration = Number(segmentList.getAttribute('duration'));
  const timescale = Number(segmentList.getAttribute('timescale') || '1');

  for (const [segmentIndex, segmentUrl] of Array.from(
    segmentList.getElementsByTagName('SegmentURL'),
  ).entries()) {
    const media = segmentUrl.getAttribute('media');
    if (!media) continue;

    const segment = createRangedSegment(
      combineUrl(segBaseUrl, media),
      segmentIndex,
      segmentUrl.getAttribute('mediaRange'),
    );
    segment.duration = duration / timescale;
    getMediaSegments(playlist).push(segment);
  }
};

const applySegmentTemplate = (params: {
  adaptationSet: Element;
  availabilityStartTime: string | null;
  bitrate: number;
  groupId: string | null;
  isLive: boolean;
  periodDurationSeconds: number;
  playlist: Playlist;
  representation: Element;
  segBaseUrl: string;
  timeShiftBufferDepth: string;
}) => {
  const {
    adaptationSet,
    availabilityStartTime,
    bitrate,
    groupId,
    isLive,
    periodDurationSeconds,
    playlist,
    representation,
    segBaseUrl,
    timeShiftBufferDepth,
  } = params;
  const adaptationSetTemplates = adaptationSet.getElementsByTagName('SegmentTemplate');
  const representationTemplates = representation.getElementsByTagName('SegmentTemplate');
  if (!adaptationSetTemplates.length && !representationTemplates.length) return;

  const segmentTemplate = representationTemplates[0] || adaptationSetTemplates[0];
  const fallbackTemplate = adaptationSetTemplates[0] || representationTemplates[0];
  const variables: Record<string, string> = {
    [DASH_TAGS.TemplateBandwidth]: String(bitrate),
    [DASH_TAGS.TemplateRepresentationID]: groupId ?? '',
  };

  const presentationTimeOffset =
    segmentTemplate.getAttribute('presentationTimeOffset') ||
    fallbackTemplate.getAttribute('presentationTimeOffset') ||
    '0';
  const timescaleString =
    segmentTemplate.getAttribute('timescale') || fallbackTemplate.getAttribute('timescale') || '1';
  const durationString =
    segmentTemplate.getAttribute('duration') || fallbackTemplate.getAttribute('duration');
  const startNumberString =
    segmentTemplate.getAttribute('startNumber') ||
    fallbackTemplate.getAttribute('startNumber') ||
    '1';
  const initialization =
    segmentTemplate.getAttribute('initialization') ||
    fallbackTemplate.getAttribute('initialization');

  if (initialization) {
    const initPath = replaceVars(initialization, variables);
    const initSegment = new MediaSegment();
    initSegment.index = -1;
    initSegment.url = combineUrl(segBaseUrl, initPath);
    playlist.mediaInit = initSegment;
  }

  const mediaTemplate =
    segmentTemplate.getAttribute('media') || fallbackTemplate.getAttribute('media');
  if (!mediaTemplate) return;

  const segmentTimeline = segmentTemplate.getElementsByTagName('SegmentTimeline')[0];
  if (segmentTimeline) {
    applySegmentTimeline({
      mediaTemplate,
      periodDurationSeconds,
      playlist,
      segBaseUrl,
      startNumberString,
      timeline: segmentTimeline,
      timescaleString,
      variables,
    });
    return;
  }

  if (!durationString) return;

  applyFixedDurationTemplate({
    availabilityStartTime,
    durationString,
    isLive,
    mediaTemplate,
    periodDurationSeconds,
    playlist,
    presentationTimeOffset,
    segBaseUrl,
    startNumberString,
    timeShiftBufferDepth,
    timescaleString,
    variables,
  });
};

const applySegmentTimeline = (params: {
  mediaTemplate: string;
  periodDurationSeconds: number;
  playlist: Playlist;
  segBaseUrl: string;
  startNumberString: string;
  timeline: Element;
  timescaleString: string;
  variables: Record<string, string>;
}) => {
  const {
    mediaTemplate,
    periodDurationSeconds,
    playlist,
    segBaseUrl,
    startNumberString,
    timeline,
    timescaleString,
    variables,
  } = params;
  const timelineEntries = timeline.getElementsByTagName('S');
  const timescale = Number(timescaleString);
  const hasTimePlaceholder = mediaTemplate.includes(DASH_TAGS.TemplateTime);
  let segmentNumber = Number(startNumberString);
  let currentTime = 0;
  let segmentIndex = 0;

  for (const entry of timelineEntries) {
    const startTime = entry.getAttribute('t');
    if (startTime) currentTime = Number(startTime);

    const duration = Number(entry.getAttribute('d'));
    let repeatCount = Number(entry.getAttribute('r'));

    appendTemplatedSegment({
      currentTime,
      duration,
      hasTimePlaceholder,
      index: segmentIndex++,
      mediaTemplate,
      playlist,
      segmentNumber: segmentNumber++,
      segBaseUrl,
      timescale,
      variables,
    });

    if (repeatCount < 0) {
      repeatCount = Math.ceil((periodDurationSeconds * timescale) / duration) - 1;
    }

    for (let i = 0; i < repeatCount; i++) {
      currentTime += duration;
      appendTemplatedSegment({
        currentTime,
        duration,
        hasTimePlaceholder,
        index: segmentIndex++,
        mediaTemplate,
        playlist,
        segmentNumber: segmentNumber++,
        segBaseUrl,
        timescale,
        variables,
      });
    }

    currentTime += duration;
  }
};

const appendTemplatedSegment = (params: {
  currentTime: number;
  duration: number;
  hasTimePlaceholder: boolean;
  index: number;
  mediaTemplate: string;
  playlist: Playlist;
  segmentNumber: number;
  segBaseUrl: string;
  timescale: number;
  variables: Record<string, string>;
}) => {
  const {
    currentTime,
    duration,
    hasTimePlaceholder,
    index,
    mediaTemplate,
    playlist,
    segmentNumber,
    segBaseUrl,
    timescale,
    variables,
  } = params;
  variables[DASH_TAGS.TemplateTime] = String(currentTime);
  variables[DASH_TAGS.TemplateNumber] = String(segmentNumber);

  const mediaSegment = new MediaSegment();
  mediaSegment.index = index;
  mediaSegment.url = combineUrl(segBaseUrl, replaceVars(mediaTemplate, variables));
  mediaSegment.duration = duration / timescale;
  if (hasTimePlaceholder) {
    mediaSegment.nameFromVar = String(currentTime);
  }
  getMediaSegments(playlist).push(mediaSegment);
};

const applyFixedDurationTemplate = (params: {
  availabilityStartTime: string | null;
  durationString: string;
  isLive: boolean;
  mediaTemplate: string;
  periodDurationSeconds: number;
  playlist: Playlist;
  presentationTimeOffset: string;
  segBaseUrl: string;
  startNumberString: string;
  timeShiftBufferDepth: string;
  timescaleString: string;
  variables: Record<string, string>;
}) => {
  const {
    availabilityStartTime,
    durationString,
    isLive,
    mediaTemplate,
    periodDurationSeconds,
    playlist,
    presentationTimeOffset,
    segBaseUrl,
    startNumberString,
    timeShiftBufferDepth,
    timescaleString,
    variables,
  } = params;
  const timescale = Number(timescaleString);
  const duration = Number(durationString);
  const hasNumberPlaceholder = mediaTemplate.includes(DASH_TAGS.TemplateNumber);
  let startNumber = Number(startNumberString);
  let totalNumber = Math.ceil((periodDurationSeconds * timescale) / duration);

  if (totalNumber === 0 && isLive) {
    if (!availabilityStartTime) {
      throw new Error('Invalid live MPD: availabilityStartTime is required.');
    }

    const now = Date.now();
    const availableTime = new Date(availabilityStartTime);
    const offsetMs = Number(presentationTimeOffset) / 1000;
    availableTime.setUTCMilliseconds(availableTime.getUTCMilliseconds() + offsetMs);
    const elapsedSeconds = (now - availableTime.getTime()) / 1000;
    const updateWindowSeconds = Temporal.Duration.from(timeShiftBufferDepth).total('seconds');
    startNumber += ((elapsedSeconds - updateWindowSeconds) * timescale) / duration;
    totalNumber = (updateWindowSeconds * timescale) / duration;
  }

  for (let number = startNumber, segmentIndex = 0; number < startNumber + totalNumber; number++) {
    variables[DASH_TAGS.TemplateNumber] = String(number);

    const mediaSegment = new MediaSegment();
    mediaSegment.index = isLive ? number : segmentIndex++;
    mediaSegment.url = combineUrl(segBaseUrl, replaceVars(mediaTemplate, variables));
    mediaSegment.duration = duration / timescale;
    if (hasNumberPlaceholder) {
      mediaSegment.nameFromVar = String(number);
    }
    getMediaSegments(playlist).push(mediaSegment);
  }
};

const ensureFallbackMediaSegment = (
  playlist: Playlist,
  segBaseUrl: string,
  periodDurationSeconds: number,
) => {
  if (getMediaSegments(playlist).length > 0) return;
  addWholeResourceSegment(playlist, segBaseUrl, periodDurationSeconds);
};

const applyContentProtection = (
  adaptationSet: Element,
  representation: Element,
  playlist: Playlist,
) => {
  const adaptationSetProtections = adaptationSet.getElementsByTagName('ContentProtection');
  const representationProtections = representation.getElementsByTagName('ContentProtection');
  const contentProtections = representationProtections[0]
    ? representationProtections
    : adaptationSetProtections;
  if (!contentProtections.length) return;

  const encryptInfo = new EncryptInfo();
  encryptInfo.method = ENCRYPT_METHODS.CENC as EncryptMethod;

  for (const contentProtection of contentProtections) {
    const schemeIdUri = contentProtection.getAttribute('schemeIdUri');
    const defaultKID = contentProtection.getAttribute('cenc:default_KID') || undefined;
    const pssh =
      contentProtection.getElementsByTagName('cenc:pssh')[0]?.textContent?.trim() || undefined;
    const drmData = { keyId: defaultKID, pssh };

    if (schemeIdUri?.includes(WIDEVINE_SYSTEM_ID)) {
      encryptInfo.drm.widevine = drmData;
    } else if (schemeIdUri?.includes(PLAYREADY_SYSTEM_ID)) {
      encryptInfo.drm.playready = drmData;
    }
  }

  if (playlist.mediaInit) {
    playlist.mediaInit.encryptInfo = encryptInfo;
  }

  for (const segment of getMediaSegments(playlist)) {
    if (!segment.encryptInfo || segment.encryptInfo.method === 'unknown') {
      segment.encryptInfo = encryptInfo;
    }
  }
};

const mergePeriodStream = (
  streams: MediaStreamInfo[],
  streamInfo: MediaStreamInfo,
  isLive: boolean,
) => {
  const existingStreamIndex = streams.findIndex(
    (item) =>
      item.type === streamInfo.type &&
      item.periodId !== streamInfo.periodId &&
      item.groupId === streamInfo.groupId &&
      (item.type === 'video' && streamInfo.type === 'video'
        ? item.width === streamInfo.width && item.height === streamInfo.height
        : true),
  );
  if (existingStreamIndex < 0) {
    streams.push(streamInfo);
    return;
  }

  if (isLive) {
    return;
  }

  const existingPlaylist = streams[existingStreamIndex]?.playlist;
  const incomingPlaylist = streamInfo.playlist;
  const lastPart = existingPlaylist?.mediaParts.at(-1);
  const lastSegment = lastPart?.mediaSegments.at(-1);
  const incomingSegments = incomingPlaylist ? getMediaSegments(incomingPlaylist) : [];
  const incomingLastSegment = incomingSegments.at(-1);
  if (!existingPlaylist || !lastPart || !lastSegment || !incomingLastSegment) {
    return;
  }

  if (lastSegment.url !== incomingLastSegment.url) {
    const startIndex = lastSegment.index + 1;
    for (const segment of incomingSegments) {
      segment.index += startIndex;
    }

    const mediaPart = new MediaPart();
    mediaPart.mediaSegments = incomingSegments;
    existingPlaylist.mediaParts.push(mediaPart);
    return;
  }

  lastSegment.duration += incomingSegments.reduce((sum, segment) => sum + segment.duration, 0);
};

const linkDefaultGroups = (streams: MediaStreamInfo[]) => {
  const audioList = streams.filter((stream) => stream.type === 'audio');
  const subtitleList = streams.filter((stream) => stream.type === 'subtitle');
  const videoList = streams.filter((stream) => stream.type === 'video');

  for (const video of videoList) {
    const audioGroupId = audioList
      .toSorted((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
      .at(0)?.groupId;
    const subtitleGroupId = subtitleList
      .toSorted((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
      .at(0)?.groupId;

    if (audioGroupId) {
      video.audioId = audioGroupId;
    }
    if (subtitleGroupId) {
      video.subtitleId = subtitleGroupId;
    }
  }
};

export class DashManifestParser {
  #mpdUrl = '';
  #baseUrl = '';
  #mpdContent = '';
  #context: DashManifestContext;

  constructor(context: DashManifestContext) {
    this.#context = context;
    this.#resetManifestUrls();
  }

  get manifestUrl() {
    return this.#context.url;
  }

  async extractStreams(rawText: string): Promise<MediaStreamInfo[]> {
    const streamInfos: MediaStreamInfo[] = [];

    this.#mpdContent = processDashContent(rawText);

    const document = new DOMParser().parseFromString(this.#mpdContent, 'text/xml');
    const mpdElement = document.getElementsByTagName('MPD')[0];
    const isLive = mpdElement.getAttribute('type') === 'dynamic';
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

    for (const period of mpdElement.getElementsByTagName('Period')) {
      const periodDurationSeconds = Temporal.Duration.from(
        period.getAttribute('duration') || mediaPresentationDuration || 'PT0S',
      ).total('seconds');
      const periodBaseUrl = extendDashBaseUrl(period, this.#baseUrl);

      for (const adaptationSet of period.getElementsByTagName('AdaptationSet')) {
        const adaptationSetBaseUrl = extendDashBaseUrl(adaptationSet, periodBaseUrl);
        const adaptationSetFrameRate = getDashFrameRate(adaptationSet);
        let contentType = adaptationSet.getAttribute('contentType');
        let mimeType = adaptationSet.getAttribute('mimeType');

        for (const representation of adaptationSet.getElementsByTagName('Representation')) {
          const segBaseUrl = extendDashBaseUrl(representation, adaptationSetBaseUrl);
          contentType ||= representation.getAttribute('contentType');
          mimeType ||= representation.getAttribute('mimeType');
          const bitrate = Number(representation.getAttribute('bandwidth') ?? '');
          const codecs =
            representation.getAttribute('codecs') || adaptationSet.getAttribute('codecs');
          const streamInfo = createDashStreamInfo({ codecs, contentType, mimeType });
          const playlist = createPlaylist(isLive, timeShiftBufferDepth);

          streamInfo.url = this.#mpdUrl;
          streamInfo.originalUrl = this.#context.originalUrl;

          applyTrackMetadata({
            adaptationSet,
            bitrate,
            frameRate: adaptationSetFrameRate,
            period,
            playlist,
            publishTime,
            representation,
            streamInfo,
          });

          applySegmentBase(representation, playlist, segBaseUrl);
          applySegmentList(representation, playlist, segBaseUrl);
          applySegmentTemplate({
            adaptationSet,
            availabilityStartTime,
            bitrate,
            groupId: streamInfo.groupId,
            isLive,
            periodDurationSeconds,
            playlist,
            representation,
            segBaseUrl,
            timeShiftBufferDepth,
          });
          ensureFallbackMediaSegment(playlist, segBaseUrl, periodDurationSeconds);
          normalizeStreamExtension(streamInfo, playlist);
          applyContentProtection(adaptationSet, representation, playlist);

          mergePeriodStream(streamInfos, streamInfo, isLive);
        }
      }
    }

    linkDefaultGroups(streamInfos);
    return streamInfos;
  }

  async refreshPlaylist(streamInfos: MediaStreamInfo[]): Promise<void> {
    if (!streamInfos.length) return;

    const response = await this.#fetchManifest(this.#context.url).catch(() =>
      this.#fetchManifest(this.#context.originalUrl),
    );
    const rawText = await response.text();

    this.#context.url = response.url;
    this.#resetManifestUrls();

    const newStreams = await this.extractStreams(rawText);
    for (const streamInfo of streamInfos) {
      let matchingStreams = newStreams.filter(
        (candidate) => candidate.toShortString() === streamInfo.toShortString(),
      );
      if (!matchingStreams.length) {
        matchingStreams = newStreams.filter(
          (candidate) => candidate.playlist?.mediaInit?.url === streamInfo.playlist?.mediaInit?.url,
        );
      }

      const nextPlaylist = matchingStreams[0]?.playlist;
      if (streamInfo.playlist && nextPlaylist) {
        streamInfo.playlist.mediaParts = nextPlaylist.mediaParts;
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

  #resetManifestUrls() {
    this.#mpdUrl = this.#context.url;
    this.#baseUrl = this.#mpdUrl;
  }
}
