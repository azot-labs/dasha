import { DOMParser, type Element } from '@xmldom/xmldom';
import { Temporal } from 'temporal-polyfill';
import { InputFormat } from 'mediabunny';
import type {
  EncodedPacket,
  Input as MediabunnyInput,
  MediaCodec,
  MetadataTags,
  PacketType,
} from 'mediabunny';
import { checkIsDescriptive, getDolbyDigitalPlusComplexityIndex, parseChannels } from '../audio';
import { ENCRYPT_METHODS } from '../encrypt-method';
import { ROLE_TYPE } from '../role-type';
import { checkIsClosedCaption, checkIsSdh } from '../subtitle';
import { combineUrl } from '../util';
import { parseDynamicRange } from '../video';
import {
  DASH_MIME_TYPE,
  DASH_TEMPLATE_BANDWIDTH,
  DASH_TEMPLATE_NUMBER,
  DASH_TEMPLATE_REPRESENTATION_ID,
  DASH_TEMPLATE_TIME,
  type DashEncryptionData,
  type DashParsedSegment,
  type DashParsedTrack,
  type DashSegmentState,
  createDashTrackDescriptor,
  extendDashBaseUrl,
  filterDashLanguage,
  getDashFrameRate,
  getDashTrackMatchKey,
  getDashTagAttrs,
  getSourceHeaders,
  isDashManifestText,
  isLikelyDashPath,
  loadDashManifest,
  parseDashRange,
  replaceDashVariables,
} from './dash-misc';
import { type DashSegment, DashSegmentedInput } from './dash-segmented-input';
import {
  createDashInternalTracks,
  createDashTrackBackings,
  type DashInputTrackBacking,
  type DashInternalTrack,
} from './dash-track-backing';

export type { DashSegment } from './dash-segmented-input';
export { DashSegmentedInput } from './dash-segmented-input';

const DASH_NAMESPACE_MAP = new Map([
  ['cenc', 'urn:mpeg:cenc:2013'],
  ['mspr', 'urn:microsoft:playready'],
  ['mas', 'urn:marlin:mas:1-0:services:schemas:mpd'],
]);

const WIDEVINE_SYSTEM_ID = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const PLAYREADY_SYSTEM_ID = '9a04f079-9840-4286-ab92-e65be0885f95';

type DashManifestInfo = {
  mpdElement: Element;
  isLive: boolean;
  availabilityStartTime: string | null;
  timeShiftBufferDepth: string;
  publishTime: string | null;
  mediaPresentationDuration: string | null;
};

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

const createDashSegmentState = (
  isLive: boolean,
  timeShiftBufferDepth: string,
): DashSegmentState => ({
  isLive,
  refreshIntervalMs: Temporal.Duration.from(timeShiftBufferDepth).total('milliseconds') / 2,
  initSegment: null,
  mediaSegments: [],
});

const addWholeResourceSegment = (segmentState: DashSegmentState, url: string, duration: number) => {
  segmentState.mediaSegments.push({
    sequenceNumber: 0,
    duration,
    url,
    encryption: null,
  });
};

const createDashRangedSegment = (
  url: string,
  sequenceNumber: number,
  range?: string | null,
): DashParsedSegment => {
  const segment: DashParsedSegment = {
    sequenceNumber,
    duration: 0,
    url,
    encryption: null,
  };

  if (range) {
    const [start, expect] = parseDashRange(range);
    segment.startRange = start;
    segment.expectLength = expect;
  }

  return segment;
};

const getRoleType = (roleValue: string) => {
  const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  const roleTypeKey = roleValue.split('-').map(capitalize).join('');
  return ROLE_TYPE[roleTypeKey as keyof typeof ROLE_TYPE];
};

const createDashTrack = (params: {
  adaptationSet: Element;
  bitrate: number;
  contentType: string | null;
  frameRate: number | undefined;
  isLive: boolean;
  manifestUrl: string;
  mimeType: string | null;
  originalUrl: string;
  period: Element;
  publishTime: string | null;
  representation: Element;
  timeShiftBufferDepth: string;
}) => {
  const {
    adaptationSet,
    contentType,
    frameRate,
    isLive,
    manifestUrl,
    mimeType,
    originalUrl,
    period,
    publishTime,
    representation,
    timeShiftBufferDepth,
  } = params;
  const bitrate = params.bitrate;
  const descriptor = createDashTrackDescriptor({
    codecs: representation.getAttribute('codecs') || adaptationSet.getAttribute('codecs'),
    contentType,
    mimeType,
  });
  const segmentState = createDashSegmentState(isLive, timeShiftBufferDepth);
  const track = {
    type: descriptor.type,
    codec: descriptor.codec,
    codecString: descriptor.codecString,
    manifestUrl,
    originalUrl,
    peakBitrate: bitrate,
    averageBitrate: bitrate,
    name: null,
    default: false,
    groupId: representation.getAttribute('id'),
    periodId: period.getAttribute('id'),
    extension: null,
    segmentState,
  } as DashParsedTrack;

  const roles = getDashTagAttrs('Role', representation, adaptationSet);
  const supplementalProps = getDashTagAttrs('SupplementalProperty', representation, adaptationSet);
  const essentialProps = getDashTagAttrs('EssentialProperty', representation, adaptationSet);
  const accessibilities = getDashTagAttrs('Accessibility', representation, adaptationSet);
  const audioChannelConfigs = getDashTagAttrs(
    'AudioChannelConfiguration',
    adaptationSet,
    representation,
  );
  const channelsString = audioChannelConfigs[0]?.value;
  const width = representation.getAttribute('width');
  const height = representation.getAttribute('height');

  track.languageCode = filterDashLanguage(
    representation.getAttribute('lang') || adaptationSet.getAttribute('lang'),
  );

  const volumeAdjust = representation.getAttribute('volumeAdjust');
  if (volumeAdjust) {
    track.groupId = `${track.groupId}-${volumeAdjust}`;
  }

  const actualMimeType =
    representation.getAttribute('mimeType') || adaptationSet.getAttribute('mimeType');
  if (actualMimeType) {
    const mimeTypeSplit = actualMimeType.split('/');
    track.extension = mimeTypeSplit.length === 2 ? mimeTypeSplit[1] : null;
  }

  if (track.type === 'video') {
    track.width = Number(width);
    track.height = Number(height);
    track.frameRate = frameRate || getDashFrameRate(representation);
    if (track.codecString && supplementalProps && essentialProps) {
      track.dynamicRange = parseDynamicRange(track.codecString, supplementalProps, essentialProps);
    }
  } else if (track.type === 'audio') {
    if (accessibilities) {
      track.descriptive = checkIsDescriptive(accessibilities);
    }
    if (supplementalProps) {
      track.joc = getDolbyDigitalPlusComplexityIndex(supplementalProps);
    }
    if (channelsString) {
      track.numberOfChannels = parseChannels(channelsString);
    }
  } else {
    if (roles) {
      track.cc = checkIsClosedCaption(roles);
    }
    if (accessibilities) {
      track.sdh = checkIsSdh(accessibilities);
    }
  }

  const role = roles[0];
  if (role?.value) {
    track.role = getRoleType(role.value);
  }

  if (publishTime) {
    track.publishTime = new Date(publishTime);
  }

  return track;
};

const normalizeDashTrackExtension = (track: DashParsedTrack) => {
  if (track.type === 'subtitle' && track.extension === 'mp4') {
    track.extension = 'm4s';
  }

  if (
    track.type !== 'subtitle' &&
    (track.extension == null || track.segmentState.mediaSegments.length > 1)
  ) {
    track.extension = 'm4s';
  }
};

const applySegmentBase = (representation: Element, track: DashParsedTrack, segBaseUrl: string) => {
  const segmentBaseElement = representation.getElementsByTagName('SegmentBase')[0];
  if (!segmentBaseElement) return;

  const initialization = segmentBaseElement.getElementsByTagName('Initialization')[0];
  if (!initialization) return;

  const sourceUrl = initialization.getAttribute('sourceURL');
  if (!sourceUrl) return;

  track.segmentState.initSegment = createDashRangedSegment(
    combineUrl(segBaseUrl, sourceUrl),
    -1,
    initialization.getAttribute('range'),
  );
};

const applySegmentList = (representation: Element, track: DashParsedTrack, segBaseUrl: string) => {
  const segmentList = representation.getElementsByTagName('SegmentList')[0];
  if (!segmentList) return;

  const initialization = segmentList.getElementsByTagName('Initialization')[0];
  if (initialization) {
    const sourceUrl = initialization.getAttribute('sourceURL');
    if (sourceUrl) {
      track.segmentState.initSegment = createDashRangedSegment(
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

    const segment = createDashRangedSegment(
      combineUrl(segBaseUrl, media),
      segmentIndex,
      segmentUrl.getAttribute('mediaRange'),
    );
    segment.duration = duration / timescale;
    track.segmentState.mediaSegments.push(segment);
  }
};

const appendTemplatedSegment = (params: {
  currentTime: number;
  duration: number;
  hasTimePlaceholder: boolean;
  index: number;
  mediaTemplate: string;
  segmentState: DashSegmentState;
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
    segmentState,
    segmentNumber,
    segBaseUrl,
    timescale,
    variables,
  } = params;
  variables[DASH_TEMPLATE_TIME] = String(currentTime);
  variables[DASH_TEMPLATE_NUMBER] = String(segmentNumber);

  segmentState.mediaSegments.push({
    sequenceNumber: index,
    duration: duration / timescale,
    url: combineUrl(segBaseUrl, replaceDashVariables(mediaTemplate, variables)),
    encryption: null,
    ...(hasTimePlaceholder ? { nameFromVar: String(currentTime) } : {}),
  });
};

const applySegmentTimeline = (params: {
  mediaTemplate: string;
  periodDurationSeconds: number;
  segmentState: DashSegmentState;
  segBaseUrl: string;
  startNumberString: string;
  timeline: Element;
  timescaleString: string;
  variables: Record<string, string>;
}) => {
  const {
    mediaTemplate,
    periodDurationSeconds,
    segmentState,
    segBaseUrl,
    startNumberString,
    timeline,
    timescaleString,
    variables,
  } = params;
  const timelineEntries = timeline.getElementsByTagName('S');
  const timescale = Number(timescaleString);
  const hasTimePlaceholder = mediaTemplate.includes(DASH_TEMPLATE_TIME);
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
      segmentState,
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
        segmentState,
        segmentNumber: segmentNumber++,
        segBaseUrl,
        timescale,
        variables,
      });
    }

    currentTime += duration;
  }
};

const applyFixedDurationTemplate = (params: {
  availabilityStartTime: string | null;
  durationString: string;
  isLive: boolean;
  mediaTemplate: string;
  periodDurationSeconds: number;
  segmentState: DashSegmentState;
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
    segmentState,
    presentationTimeOffset,
    segBaseUrl,
    startNumberString,
    timeShiftBufferDepth,
    timescaleString,
    variables,
  } = params;
  const timescale = Number(timescaleString);
  const duration = Number(durationString);
  const hasNumberPlaceholder = mediaTemplate.includes(DASH_TEMPLATE_NUMBER);
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
    variables[DASH_TEMPLATE_NUMBER] = String(number);

    segmentState.mediaSegments.push({
      sequenceNumber: isLive ? number : segmentIndex++,
      duration: duration / timescale,
      url: combineUrl(segBaseUrl, replaceDashVariables(mediaTemplate, variables)),
      encryption: null,
      ...(hasNumberPlaceholder ? { nameFromVar: String(number) } : {}),
    });
  }
};

const applySegmentTemplate = (params: {
  adaptationSet: Element;
  availabilityStartTime: string | null;
  bitrate: number;
  groupId: string | null;
  isLive: boolean;
  periodDurationSeconds: number;
  representation: Element;
  segBaseUrl: string;
  segmentState: DashSegmentState;
  timeShiftBufferDepth: string;
}) => {
  const {
    adaptationSet,
    availabilityStartTime,
    bitrate,
    groupId,
    isLive,
    periodDurationSeconds,
    representation,
    segBaseUrl,
    segmentState,
    timeShiftBufferDepth,
  } = params;
  const adaptationSetTemplates = adaptationSet.getElementsByTagName('SegmentTemplate');
  const representationTemplates = representation.getElementsByTagName('SegmentTemplate');
  if (!adaptationSetTemplates.length && !representationTemplates.length) return;

  const segmentTemplate = representationTemplates[0] || adaptationSetTemplates[0];
  const fallbackTemplate = adaptationSetTemplates[0] || representationTemplates[0];
  const variables: Record<string, string> = {
    [DASH_TEMPLATE_BANDWIDTH]: String(bitrate),
    [DASH_TEMPLATE_REPRESENTATION_ID]: groupId ?? '',
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
    segmentState.initSegment = {
      sequenceNumber: -1,
      duration: 0,
      url: combineUrl(segBaseUrl, replaceDashVariables(initialization, variables)),
      encryption: null,
    };
  }

  const mediaTemplate =
    segmentTemplate.getAttribute('media') || fallbackTemplate.getAttribute('media');
  if (!mediaTemplate) return;

  const segmentTimeline = segmentTemplate.getElementsByTagName('SegmentTimeline')[0];
  if (segmentTimeline) {
    applySegmentTimeline({
      mediaTemplate,
      periodDurationSeconds,
      segmentState,
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
    segmentState,
    presentationTimeOffset,
    segBaseUrl,
    startNumberString,
    timeShiftBufferDepth,
    timescaleString,
    variables,
  });
};

const ensureFallbackMediaSegment = (
  track: DashParsedTrack,
  segBaseUrl: string,
  periodDurationSeconds: number,
) => {
  if (track.segmentState.mediaSegments.length > 0) return;
  addWholeResourceSegment(track.segmentState, segBaseUrl, periodDurationSeconds);
};

const cloneEncryption = (encryption: DashEncryptionData | null): DashEncryptionData | null =>
  encryption
    ? {
        method: encryption.method,
        key: encryption.key,
        iv: encryption.iv,
        drm: { ...encryption.drm },
      }
    : null;

const applyContentProtection = (
  adaptationSet: Element,
  representation: Element,
  track: DashParsedTrack,
) => {
  const adaptationSetProtections = adaptationSet.getElementsByTagName('ContentProtection');
  const representationProtections = representation.getElementsByTagName('ContentProtection');
  const contentProtections = representationProtections[0]
    ? representationProtections
    : adaptationSetProtections;
  if (!contentProtections.length) return;

  const encryption: DashEncryptionData = {
    method: ENCRYPT_METHODS.CENC,
    drm: {},
  };

  for (const contentProtection of contentProtections) {
    const schemeIdUri = contentProtection.getAttribute('schemeIdUri');
    const defaultKID = contentProtection.getAttribute('cenc:default_KID') || undefined;
    const pssh =
      contentProtection.getElementsByTagName('cenc:pssh')[0]?.textContent?.trim() || undefined;
    const drmData = { keyId: defaultKID, pssh };

    if (schemeIdUri?.includes(WIDEVINE_SYSTEM_ID)) {
      encryption.drm.widevine = drmData;
    } else if (schemeIdUri?.includes(PLAYREADY_SYSTEM_ID)) {
      encryption.drm.playready = drmData;
    }
  }

  if (track.segmentState.initSegment) {
    track.segmentState.initSegment.encryption = cloneEncryption(encryption);
  }

  for (const segment of track.segmentState.mediaSegments) {
    if (!segment.encryption) {
      segment.encryption = cloneEncryption(encryption);
    }
  }
};

const mergeDashPeriodTrack = (
  tracks: DashParsedTrack[],
  track: DashParsedTrack,
  isLive: boolean,
) => {
  const existingTrackIndex = tracks.findIndex(
    (item) =>
      item.type === track.type &&
      item.periodId !== track.periodId &&
      item.groupId === track.groupId &&
      (item.type === 'video' && track.type === 'video'
        ? item.width === track.width && item.height === track.height
        : true),
  );
  if (existingTrackIndex < 0) {
    tracks.push(track);
    return;
  }

  if (isLive) {
    return;
  }

  const existingTrack = tracks[existingTrackIndex];
  if (!existingTrack) {
    return;
  }

  const lastSegment = existingTrack.segmentState.mediaSegments.at(-1);
  const incomingSegments = track.segmentState.mediaSegments;
  const incomingLastSegment = incomingSegments.at(-1);
  if (!lastSegment || !incomingLastSegment) {
    return;
  }

  if (lastSegment.url !== incomingLastSegment.url) {
    const startIndex = (lastSegment.sequenceNumber ?? 0) + 1;
    for (const segment of incomingSegments) {
      if (segment.sequenceNumber !== null) {
        segment.sequenceNumber += startIndex;
      }
    }
    existingTrack.segmentState.mediaSegments.push(...incomingSegments);
    return;
  }

  lastSegment.duration += incomingSegments.reduce((sum, segment) => sum + segment.duration, 0);
};

const linkDefaultDashGroups = (tracks: DashParsedTrack[]) => {
  const audioList = tracks.filter((track) => track.type === 'audio');
  const subtitleList = tracks.filter((track) => track.type === 'subtitle');
  const videoList = tracks.filter((track) => track.type === 'video');

  for (const video of videoList) {
    const audioGroupId = audioList
      .toSorted((a, b) => (b.peakBitrate || 0) - (a.peakBitrate || 0))
      .at(0)?.groupId;
    const subtitleGroupId = subtitleList
      .toSorted((a, b) => (b.peakBitrate || 0) - (a.peakBitrate || 0))
      .at(0)?.groupId;

    if (audioGroupId) {
      video.audioGroupId = audioGroupId;
    }
    if (subtitleGroupId) {
      video.subtitleGroupId = subtitleGroupId;
    }
  }
};

export class DashDemuxer {
  input: MediabunnyInput;
  metadataPromise: Promise<void> | null = null;
  trackBackings: DashInputTrackBacking[] | null = null;
  internalTracks: DashInternalTrack[] | null = null;
  segmentedInputs: DashSegmentedInput[] = [];
  manifestUrl = '';
  originalUrl = '';
  headers: Record<string, string>;
  _mpdUrl = '';
  _baseUrl = '';

  constructor(input: MediabunnyInput) {
    this.input = input;
    this.headers = getSourceHeaders(input.source);
  }

  readMetadata() {
    return (this.metadataPromise ??= (async () => {
      const { text, url } = await loadDashManifest(this.input.source);
      this.manifestUrl = url;
      this.originalUrl = url;
      this._resetManifestUrls();

      const tracks = this._extractTracks(text.trim());
      const internalTracks = createDashInternalTracks(this, tracks);

      this.internalTracks = internalTracks;
      this.trackBackings = createDashTrackBackings(internalTracks);
    })());
  }

  async getTrackBackings() {
    await this.readMetadata();

    if (!this.trackBackings) {
      throw new Error('DASH track metadata did not initialize correctly.');
    }

    return this.trackBackings;
  }

  getSegmentedInputForTrack(track: DashInternalTrack) {
    let segmentedInput = this.segmentedInputs.find((value) => value.internalTrack === track);
    if (segmentedInput) {
      return segmentedInput;
    }

    segmentedInput = new DashSegmentedInput(track);
    this.segmentedInputs.push(segmentedInput);
    return segmentedInput;
  }

  async refreshTrackSegments(track: DashInternalTrack) {
    await this.readMetadata();

    if (!track.track.segmentState.isLive) {
      return;
    }
    if (!this.manifestUrl.startsWith('http://') && !this.manifestUrl.startsWith('https://')) {
      return;
    }

    const tracks = this.internalTracks?.map((internalTrack) => internalTrack.track) ?? [];
    await this._refreshTracks(tracks);
  }

  async getMimeType() {
    return DASH.mimeType;
  }

  async getMetadataTags(): Promise<MetadataTags> {
    return {};
  }

  dispose() {
    this.segmentedInputs.length = 0;
  }

  _extractTracks(rawText: string): DashParsedTrack[] {
    const manifest = this._parseManifest(rawText);
    const tracks: DashParsedTrack[] = [];

    for (const period of manifest.mpdElement.getElementsByTagName('Period')) {
      this._appendPeriodTracks(tracks, manifest, period);
    }

    linkDefaultDashGroups(tracks);
    return tracks;
  }

  _parseManifest(rawText: string): DashManifestInfo {
    const mpdContent = processDashContent(rawText);
    const document = new DOMParser().parseFromString(mpdContent, 'text/xml');
    const mpdElement = document.getElementsByTagName('MPD')[0];
    const manifest: DashManifestInfo = {
      mpdElement,
      isLive: mpdElement.getAttribute('type') === 'dynamic',
      availabilityStartTime: mpdElement.getAttribute('availabilityStartTime'),
      timeShiftBufferDepth: mpdElement.getAttribute('timeShiftBufferDepth') || 'PT1M',
      publishTime: mpdElement.getAttribute('publishTime'),
      mediaPresentationDuration: mpdElement.getAttribute('mediaPresentationDuration'),
    };

    const baseUrlElement = mpdElement.getElementsByTagName('BaseURL')[0];
    if (baseUrlElement?.textContent) {
      let baseUrl = baseUrlElement.textContent;
      if (baseUrl.includes('kkbox.com.tw/')) {
        baseUrl = baseUrl.replace('//https:%2F%2F', '//');
      }
      this._baseUrl = combineUrl(this._mpdUrl, baseUrl);
    }

    return manifest;
  }

  _appendPeriodTracks(
    tracks: DashParsedTrack[],
    manifest: DashManifestInfo,
    period: Element,
  ): void {
    const periodDurationSeconds = Temporal.Duration.from(
      period.getAttribute('duration') || manifest.mediaPresentationDuration || 'PT0S',
    ).total('seconds');
    const periodBaseUrl = extendDashBaseUrl(period, this._baseUrl);

    for (const adaptationSet of period.getElementsByTagName('AdaptationSet')) {
      this._appendAdaptationSetTracks({
        tracks,
        manifest,
        period,
        periodDurationSeconds,
        periodBaseUrl,
        adaptationSet,
      });
    }
  }

  _appendAdaptationSetTracks(params: {
    tracks: DashParsedTrack[];
    manifest: DashManifestInfo;
    period: Element;
    periodDurationSeconds: number;
    periodBaseUrl: string;
    adaptationSet: Element;
  }): void {
    const { tracks, manifest, period, periodDurationSeconds, periodBaseUrl, adaptationSet } =
      params;
    const adaptationSetBaseUrl = extendDashBaseUrl(adaptationSet, periodBaseUrl);
    const adaptationSetFrameRate = getDashFrameRate(adaptationSet);
    let contentType = adaptationSet.getAttribute('contentType');
    let mimeType = adaptationSet.getAttribute('mimeType');

    for (const representation of adaptationSet.getElementsByTagName('Representation')) {
      const segmentBaseUrl = extendDashBaseUrl(representation, adaptationSetBaseUrl);
      contentType ||= representation.getAttribute('contentType');
      mimeType ||= representation.getAttribute('mimeType');
      const bitrate = Number(representation.getAttribute('bandwidth') ?? '');
      const track = this._createTrack({
        adaptationSet,
        representation,
        period,
        manifest,
        bitrate,
        contentType,
        mimeType,
        frameRate: adaptationSetFrameRate,
      });

      this._populateTrackSegments({
        adaptationSet,
        representation,
        track,
        manifest,
        segmentBaseUrl,
        periodDurationSeconds,
        bitrate,
      });

      mergeDashPeriodTrack(tracks, track, manifest.isLive);
    }
  }

  _createTrack(params: {
    adaptationSet: Element;
    representation: Element;
    period: Element;
    manifest: DashManifestInfo;
    bitrate: number;
    contentType: string | null;
    mimeType: string | null;
    frameRate: number | undefined;
  }): DashParsedTrack {
    const {
      adaptationSet,
      representation,
      period,
      manifest,
      bitrate,
      contentType,
      mimeType,
      frameRate,
    } = params;

    return createDashTrack({
      adaptationSet,
      bitrate,
      contentType,
      frameRate,
      isLive: manifest.isLive,
      manifestUrl: this._mpdUrl,
      mimeType,
      originalUrl: this.originalUrl,
      period,
      publishTime: manifest.publishTime,
      representation,
      timeShiftBufferDepth: manifest.timeShiftBufferDepth,
    });
  }

  _populateTrackSegments(params: {
    adaptationSet: Element;
    representation: Element;
    track: DashParsedTrack;
    manifest: DashManifestInfo;
    segmentBaseUrl: string;
    periodDurationSeconds: number;
    bitrate: number;
  }): void {
    const {
      adaptationSet,
      representation,
      track,
      manifest,
      segmentBaseUrl,
      periodDurationSeconds,
      bitrate,
    } = params;

    applySegmentBase(representation, track, segmentBaseUrl);
    applySegmentList(representation, track, segmentBaseUrl);
    applySegmentTemplate({
      adaptationSet,
      availabilityStartTime: manifest.availabilityStartTime,
      bitrate,
      groupId: track.groupId,
      isLive: manifest.isLive,
      periodDurationSeconds,
      representation,
      segBaseUrl: segmentBaseUrl,
      segmentState: track.segmentState,
      timeShiftBufferDepth: manifest.timeShiftBufferDepth,
    });
    ensureFallbackMediaSegment(track, segmentBaseUrl, periodDurationSeconds);
    normalizeDashTrackExtension(track);
    applyContentProtection(adaptationSet, representation, track);
  }

  _findMatchingTrack(
    nextTracks: DashParsedTrack[],
    currentTrack: DashParsedTrack,
  ): DashParsedTrack | undefined {
    let matchingTracks = nextTracks.filter(
      (candidate) => getDashTrackMatchKey(candidate) === getDashTrackMatchKey(currentTrack),
    );
    if (!matchingTracks.length) {
      matchingTracks = nextTracks.filter(
        (candidate) =>
          candidate.segmentState.initSegment?.url === currentTrack.segmentState.initSegment?.url,
      );
    }

    return matchingTracks[0];
  }

  async _refreshTracks(tracks: DashParsedTrack[]): Promise<void> {
    if (!tracks.length) return;

    const response = await this._fetchManifest(this.manifestUrl).catch(() =>
      this._fetchManifest(this.originalUrl),
    );
    const rawText = await response.text();

    this.manifestUrl = response.url;
    this._resetManifestUrls();

    const newTracks = this._extractTracks(rawText);
    for (const track of tracks) {
      const nextTrack = this._findMatchingTrack(newTracks, track);
      if (!nextTrack) {
        continue;
      }

      track.segmentState = nextTrack.segmentState;
      track.publishTime = nextTrack.publishTime;
      track.manifestUrl = nextTrack.manifestUrl;
      track.originalUrl = nextTrack.originalUrl;
      track.audioGroupId = nextTrack.audioGroupId;
      track.subtitleGroupId = nextTrack.subtitleGroupId;
    }
  }

  async _fetchManifest(url: string) {
    const response = await fetch(url, { headers: this.headers });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch DASH manifest: ${response.status} ${response.statusText} (${response.url})`,
      );
    }
    return response;
  }

  _resetManifestUrls() {
    this._mpdUrl = this.manifestUrl;
    this._baseUrl = this._mpdUrl;
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
