import { DOMParser, type Element } from '@xmldom/xmldom';
import { Temporal } from 'temporal-polyfill';
import { ADTS, InputFormat, MATROSKA, MP3, MP4, QTFF, WEBM } from 'mediabunny';
import type {
  AudioCodec,
  DurationMetadataRequestOptions,
  EncodedPacket,
  Input as MediabunnyInput,
  MediaCodec,
  MetadataTags,
  PacketRetrievalOptions,
  TrackDisposition,
  VideoCodec,
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
  createDashTrackDescriptor,
  extendDashBaseUrl,
  getDirectDashChild,
  getDirectDashChildren,
  getDashFrameRate,
  getDashTrackMatchKey,
  getDashTagAttrs,
  getInheritedDashChild,
  getSourceHeaders,
  isDashManifestText,
  isLikelyDashPath,
  loadDashManifest,
  parseDashRange,
  replaceDashVariables,
} from './dash-misc';
import { type DashSegment, DashSegmentedInput } from './dash-segmented-input';

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
  mediaPresentationDuration: string | null;
};

type DashTrackInfo =
  | {
      type: 'video';
      width: number | null;
      height: number | null;
    }
  | {
      type: 'audio';
      numberOfChannels: number | null;
    }
  | {
      type: 'subtitle';
    };

type InternalTrack = {
  id: number;
  demuxer: DashDemuxer;
  backingTrack: DashInputTrackBacking | null;
  pairingMask: bigint;
  track: DashParsedTrack;
  info: DashTrackInfo;
};

type InternalVideoTrack = InternalTrack & {
  info: Extract<DashTrackInfo, { type: 'video' }>;
  track: Extract<DashParsedTrack, { type: 'video' }>;
};

type InternalAudioTrack = InternalTrack & {
  info: Extract<DashTrackInfo, { type: 'audio' }>;
  track: Extract<DashParsedTrack, { type: 'audio' }>;
};

type InternalSubtitleTrack = InternalTrack & {
  info: Extract<DashTrackInfo, { type: 'subtitle' }>;
  track: Extract<DashParsedTrack, { type: 'subtitle' }>;
};

export type DashInternalTrack = InternalTrack;

const DEFAULT_TRACK_DISPOSITION: TrackDisposition = {
  commentary: false,
  default: true,
  forced: false,
  hearingImpaired: false,
  original: false,
  primary: true,
  visuallyImpaired: false,
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

const getDashRefreshIntervalMs = (timeShiftBufferDepth: string) =>
  Temporal.Duration.from(timeShiftBufferDepth).total('milliseconds') / 2;

const getDisposition = (track: DashParsedTrack): TrackDisposition => ({
  ...DEFAULT_TRACK_DISPOSITION,
  commentary: track.role === ROLE_TYPE.Commentary,
  default: !!track.default,
  forced: track.role === ROLE_TYPE.ForcedSubtitle || !!(track.type === 'subtitle' && track.forced),
  hearingImpaired: !!(track.type === 'subtitle' && track.sdh),
  visuallyImpaired: !!(track.type === 'audio' && track.descriptive),
});

const canPairTracks = (left: DashParsedTrack, right: DashParsedTrack) => {
  if (left === right || left.type === right.type) {
    return false;
  }

  if (left.type === 'video' && right.type === 'audio') {
    return !left.audioGroupId || left.audioGroupId === right.groupId;
  }

  if (left.type === 'audio' && right.type === 'video') {
    return !right.audioGroupId || right.audioGroupId === left.groupId;
  }

  if (left.type === 'video' && right.type === 'subtitle') {
    return !left.subtitleGroupId || left.subtitleGroupId === right.groupId;
  }

  if (left.type === 'subtitle' && right.type === 'video') {
    return !right.subtitleGroupId || right.subtitleGroupId === left.groupId;
  }

  return false;
};

const createPairingMasks = (tracks: DashParsedTrack[]) => {
  const masks = new Map<DashParsedTrack, bigint>();
  let nextPairIndex = 0;

  for (const [leftIndex, left] of tracks.entries()) {
    for (const right of tracks.slice(leftIndex + 1)) {
      if (!canPairTracks(left, right)) {
        continue;
      }

      const bit = 1n << BigInt(nextPairIndex++);
      masks.set(left, (masks.get(left) ?? 0n) | bit);
      masks.set(right, (masks.get(right) ?? 0n) | bit);
    }
  }

  return masks;
};

const createTrackInfo = (track: DashParsedTrack): DashTrackInfo => {
  if (track.type === 'video') {
    return {
      type: 'video',
      width: track.width ?? null,
      height: track.height ?? null,
    };
  }

  if (track.type === 'audio') {
    return {
      type: 'audio',
      numberOfChannels: track.numberOfChannels ?? null,
    };
  }

  return { type: 'subtitle' };
};

const createInternalTracks = (demuxer: DashDemuxer, tracks: DashParsedTrack[]): InternalTrack[] => {
  const pairingMasks = createPairingMasks(tracks);

  return tracks.map((track, index) => ({
    id: index + 1,
    demuxer,
    backingTrack: null,
    pairingMask: pairingMasks.get(track) ?? 0n,
    track,
    info: createTrackInfo(track),
  }));
};

const getTrackNumber = (internalTrack: InternalTrack) => {
  const internalTracks = internalTrack.demuxer.internalTracks;
  if (!internalTracks) {
    return 1;
  }

  let number = 0;
  for (const track of internalTracks) {
    if (track.info.type === internalTrack.info.type) {
      number++;
    }
    if (track === internalTrack) {
      break;
    }
  }

  return number;
};

const addWholeResourceSegment = (track: DashParsedTrack, url: string, duration: number) => {
  track.mediaSegments.push({
    sequenceNumber: 0,
    duration,
    url,
    encryption: null,
  });
};

const appendDashSegment = (track: DashParsedTrack, segment: DashParsedSegment) => {
  track.mediaSegments.push(segment);
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

const getSegmentTimelineEntries = (timeline: Element, timescale: number, limit: number) => {
  const entries: { duration: number; timestamp: number }[] = [];
  let currentTime = 0;

  for (const entry of getDirectDashChildren(timeline, 'S')) {
    const duration = Number(entry.getAttribute('d'));
    if (!Number.isFinite(duration)) {
      continue;
    }

    const startTime = entry.getAttribute('t');
    if (startTime) {
      currentTime = Number(startTime);
    }

    let repeatCount = Number(entry.getAttribute('r'));
    if (!Number.isFinite(repeatCount)) {
      repeatCount = 0;
    }

    const remaining = limit - entries.length;
    if (remaining <= 0) {
      break;
    }

    const totalEntries = repeatCount < 0 ? remaining : Math.min(repeatCount + 1, remaining);

    for (let i = 0; i < totalEntries; i++) {
      entries.push({
        duration: duration / timescale,
        timestamp: currentTime / timescale,
      });
      currentTime += duration;
    }
  }

  return entries;
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
  mimeType: string | null;
  period: Element;
  representation: Element;
  timeShiftBufferDepth: string;
}) => {
  const {
    adaptationSet,
    contentType,
    frameRate,
    isLive,
    mimeType,
    period,
    representation,
    timeShiftBufferDepth,
  } = params;
  const bitrate = params.bitrate;
  const descriptor = createDashTrackDescriptor({
    codecs: representation.getAttribute('codecs') || adaptationSet.getAttribute('codecs'),
    contentType,
    mimeType,
  });
  const track = {
    type: descriptor.type,
    codec: descriptor.codec,
    codecString: descriptor.codecString,
    peakBitrate: bitrate,
    averageBitrate: bitrate,
    name: null,
    default: false,
    groupId: representation.getAttribute('id'),
    periodId: period.getAttribute('id'),
    extension: null,
    isLive,
    refreshIntervalMs: getDashRefreshIntervalMs(timeShiftBufferDepth),
    initSegment: null,
    mediaSegments: [],
  } as DashParsedTrack;

  const roles = getDashTagAttrs('Role', representation, adaptationSet);
  const supplementalProps = getDashTagAttrs('SupplementalProperty', representation, adaptationSet);
  const essentialProps = getDashTagAttrs('EssentialProperty', representation, adaptationSet);
  const accessibilities = getDashTagAttrs('Accessibility', representation, adaptationSet);
  const audioChannelConfigs = getDashTagAttrs(
    'AudioChannelConfiguration',
    representation,
    adaptationSet,
  );
  const channelsString = audioChannelConfigs[0]?.value;
  const width = representation.getAttribute('width');
  const height = representation.getAttribute('height');

  track.languageCode =
    representation.getAttribute('lang') || adaptationSet.getAttribute('lang') || undefined;

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
    if (width) {
      track.width = Number(width);
    }
    if (height) {
      track.height = Number(height);
    }
    track.frameRate = frameRate ?? getDashFrameRate(representation);
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

  return track;
};

const normalizeDashTrackExtension = (track: DashParsedTrack) => {
  if (track.type === 'subtitle' && track.extension === 'mp4') {
    track.extension = 'm4s';
  }

  if (track.type !== 'subtitle' && (track.extension == null || track.mediaSegments.length > 1)) {
    track.extension = 'm4s';
  }
};

const getDashSegmentSourceChild = (
  tag: string,
  representation: Element,
  adaptationSet: Element,
  period: Element,
) => getInheritedDashChild(tag, representation, adaptationSet, period);

const applySegmentBase = (params: {
  adaptationSet: Element;
  period: Element;
  representation: Element;
  track: DashParsedTrack;
  segmentBaseUrl: string;
}) => {
  const { adaptationSet, period, representation, track, segmentBaseUrl } = params;
  const segmentBaseElement = getDashSegmentSourceChild(
    'SegmentBase',
    representation,
    adaptationSet,
    period,
  );
  if (!segmentBaseElement) return;

  const initialization = getDirectDashChild(segmentBaseElement, 'Initialization');
  if (!initialization) return;

  track.initSegment = createDashRangedSegment(
    combineUrl(segmentBaseUrl, initialization.getAttribute('sourceURL') || ''),
    -1,
    initialization.getAttribute('range'),
  );
};

const applySegmentList = (params: {
  adaptationSet: Element;
  period: Element;
  representation: Element;
  track: DashParsedTrack;
  segmentBaseUrl: string;
}) => {
  const { adaptationSet, period, representation, track, segmentBaseUrl } = params;
  const segmentList = getDashSegmentSourceChild(
    'SegmentList',
    representation,
    adaptationSet,
    period,
  );
  if (!segmentList) return;

  const initialization = getDirectDashChild(segmentList, 'Initialization');
  if (initialization) {
    track.initSegment = createDashRangedSegment(
      combineUrl(segmentBaseUrl, initialization.getAttribute('sourceURL') || ''),
      -1,
      initialization.getAttribute('range'),
    );
  }

  const timescale = Number(segmentList.getAttribute('timescale') || '1');
  const segmentUrls = getDirectDashChildren(segmentList, 'SegmentURL');
  const segmentTimeline = getDirectDashChild(segmentList, 'SegmentTimeline');
  const timelineEntries = segmentTimeline
    ? getSegmentTimelineEntries(segmentTimeline, timescale, segmentUrls.length)
    : null;
  const fixedDurationAttr = segmentList.getAttribute('duration');
  const fixedDuration = fixedDurationAttr ? Number(fixedDurationAttr) : Number.NaN;

  for (const [segmentIndex, segmentUrl] of segmentUrls.entries()) {
    const media = segmentUrl.getAttribute('media');
    if (!media) continue;

    const duration = timelineEntries?.[segmentIndex]?.duration ?? fixedDuration / timescale;
    if (!Number.isFinite(duration)) {
      break;
    }

    const segment = createDashRangedSegment(
      combineUrl(segmentBaseUrl, media),
      segmentIndex,
      segmentUrl.getAttribute('mediaRange'),
    );
    segment.timestamp = timelineEntries?.[segmentIndex]?.timestamp;
    segment.duration = duration;
    appendDashSegment(track, segment);
  }
};

const appendTemplatedSegment = (params: {
  currentTime: number;
  duration: number;
  index: number;
  mediaTemplate: string;
  track: DashParsedTrack;
  segmentNumber: number;
  segBaseUrl: string;
  timescale: number;
  variables: Record<string, string>;
}) => {
  const { currentTime, duration, index, mediaTemplate, track } = params;
  const { segmentNumber, segBaseUrl, timescale, variables } = params;
  variables[DASH_TEMPLATE_TIME] = String(currentTime);
  variables[DASH_TEMPLATE_NUMBER] = String(segmentNumber);

  appendDashSegment(track, {
    sequenceNumber: index,
    timestamp: currentTime / timescale,
    duration: duration / timescale,
    url: combineUrl(segBaseUrl, replaceDashVariables(mediaTemplate, variables)),
    encryption: null,
  });
};

const applySegmentTimeline = (params: {
  mediaTemplate: string;
  periodDurationSeconds: number;
  track: DashParsedTrack;
  segBaseUrl: string;
  startNumberString: string;
  timeline: Element;
  timescaleString: string;
  variables: Record<string, string>;
}) => {
  const { mediaTemplate, periodDurationSeconds, track, segBaseUrl } = params;
  const { startNumberString, timeline, timescaleString, variables } = params;
  const timelineEntries = getDirectDashChildren(timeline, 'S');
  const timescale = Number(timescaleString);
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
      index: segmentIndex++,
      mediaTemplate,
      track,
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
        index: segmentIndex++,
        mediaTemplate,
        track,
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
  track: DashParsedTrack;
  presentationTimeOffset: string;
  segBaseUrl: string;
  startNumberString: string;
  timeShiftBufferDepth: string;
  timescaleString: string;
  variables: Record<string, string>;
}) => {
  const { availabilityStartTime, durationString, isLive, mediaTemplate, periodDurationSeconds } =
    params;
  const { presentationTimeOffset, segBaseUrl, startNumberString, timeShiftBufferDepth } = params;
  const { timescaleString, track, variables } = params;
  const timescale = Number(timescaleString);
  const duration = Number(durationString);
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
    variables[DASH_TEMPLATE_TIME] = String((number - startNumber) * duration);
    variables[DASH_TEMPLATE_NUMBER] = String(number);

    appendDashSegment(track, {
      sequenceNumber: isLive ? number : segmentIndex++,
      timestamp: (number - startNumber) * (duration / timescale),
      duration: duration / timescale,
      url: combineUrl(segBaseUrl, replaceDashVariables(mediaTemplate, variables)),
      encryption: null,
    });
  }
};

const applySegmentTemplate = (params: {
  adaptationSet: Element;
  availabilityStartTime: string | null;
  bitrate: number;
  isLive: boolean;
  period: Element;
  periodDurationSeconds: number;
  representationId: string | null;
  representation: Element;
  segBaseUrl: string;
  track: DashParsedTrack;
  timeShiftBufferDepth: string;
}) => {
  const { adaptationSet, availabilityStartTime, bitrate, isLive, period } = params;
  const {
    periodDurationSeconds,
    representation,
    representationId,
    segBaseUrl,
    track,
    timeShiftBufferDepth,
  } = params;
  const segmentTemplates = [
    getDirectDashChild(representation, 'SegmentTemplate'),
    getDirectDashChild(adaptationSet, 'SegmentTemplate'),
    getDirectDashChild(period, 'SegmentTemplate'),
  ].filter((template): template is Element => !!template);
  const segmentTemplate = segmentTemplates[0];
  if (!segmentTemplate) {
    return;
  }

  const getTemplateAttribute = (name: string) => {
    for (const template of segmentTemplates) {
      const value = template.getAttribute(name);
      if (value) {
        return value;
      }
    }
    return null;
  };

  const getTemplateTimeline = () => {
    for (const template of segmentTemplates) {
      const timeline = getDirectDashChild(template, 'SegmentTimeline');
      if (timeline) {
        return timeline;
      }
    }
  };

  const variables: Record<string, string> = {
    [DASH_TEMPLATE_BANDWIDTH]: String(bitrate),
    [DASH_TEMPLATE_REPRESENTATION_ID]: representationId ?? '',
  };

  const presentationTimeOffset = getTemplateAttribute('presentationTimeOffset') || '0';
  const timescaleString = getTemplateAttribute('timescale') || '1';
  const durationString = getTemplateAttribute('duration');
  const startNumberString = getTemplateAttribute('startNumber') || '1';
  const initialization = getTemplateAttribute('initialization');

  if (initialization) {
    track.initSegment = {
      sequenceNumber: -1,
      duration: 0,
      url: combineUrl(segBaseUrl, replaceDashVariables(initialization, variables)),
      encryption: null,
    };
  }

  const mediaTemplate = getTemplateAttribute('media');
  if (!mediaTemplate) return;

  const segmentTimeline = getTemplateTimeline();
  if (segmentTimeline) {
    applySegmentTimeline({
      mediaTemplate,
      periodDurationSeconds,
      track,
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
    track,
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
  if (track.mediaSegments.length > 0) return;
  addWholeResourceSegment(track, segBaseUrl, periodDurationSeconds);
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
  const representationProtections = getDirectDashChildren(representation, 'ContentProtection');
  const adaptationSetProtections = getDirectDashChildren(adaptationSet, 'ContentProtection');
  const contentProtections = representationProtections.length
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
      getDirectDashChild(contentProtection, 'cenc:pssh')?.textContent?.trim() || undefined;
    const drmData = { keyId: defaultKID, pssh };

    if (schemeIdUri?.includes(WIDEVINE_SYSTEM_ID)) {
      encryption.drm.widevine = drmData;
    } else if (schemeIdUri?.includes(PLAYREADY_SYSTEM_ID)) {
      encryption.drm.playready = drmData;
    }
  }

  if (track.initSegment) {
    track.initSegment.encryption = cloneEncryption(encryption);
  }

  for (const segment of track.mediaSegments) {
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

  const lastSegment = existingTrack.mediaSegments.at(-1);
  const incomingSegments = track.mediaSegments;
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
    existingTrack.mediaSegments.push(...incomingSegments);
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
  internalTracks: InternalTrack[] | null = null;
  segmentedInputs: DashSegmentedInput[] = [];
  manifestUrl = '';
  originalUrl = '';
  headers: Record<string, string>;
  mpdUrl = '';
  baseUrl = '';

  constructor(input: MediabunnyInput) {
    this.input = input;
    this.headers = getSourceHeaders(input.source);
  }

  readMetadata() {
    return (this.metadataPromise ??= (async () => {
      const { text, url } = await loadDashManifest(this.input.source);
      this.manifestUrl = url;
      this.originalUrl = url;
      this.resetManifestUrls();

      const tracks = this.extractTracks(text.trim());
      const internalTracks = createInternalTracks(this, tracks);

      this.internalTracks = internalTracks;
      this.trackBackings = createTrackBackings(internalTracks);
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

    if (!track.track.isLive) {
      return;
    }
    if (!this.manifestUrl.startsWith('http://') && !this.manifestUrl.startsWith('https://')) {
      return;
    }

    const tracks = this.internalTracks?.map((internalTrack) => internalTrack.track) ?? [];
    await this.refreshTracks(tracks);
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

  extractTracks(rawText: string): DashParsedTrack[] {
    const manifest = this.parseManifest(rawText);
    const tracks: DashParsedTrack[] = [];

    for (const period of getDirectDashChildren(manifest.mpdElement, 'Period')) {
      this.appendPeriodTracks(tracks, manifest, period);
    }

    linkDefaultDashGroups(tracks);
    return tracks;
  }

  parseManifest(rawText: string): DashManifestInfo {
    const mpdContent = processDashContent(rawText);
    const document = new DOMParser().parseFromString(mpdContent, 'text/xml');
    const mpdElement = document.getElementsByTagName('MPD')[0];
    const manifest: DashManifestInfo = {
      mpdElement,
      isLive: mpdElement.getAttribute('type') === 'dynamic',
      availabilityStartTime: mpdElement.getAttribute('availabilityStartTime'),
      timeShiftBufferDepth: mpdElement.getAttribute('timeShiftBufferDepth') || 'PT1M',
      mediaPresentationDuration: mpdElement.getAttribute('mediaPresentationDuration'),
    };

    const baseUrlElement = getDirectDashChild(mpdElement, 'BaseURL');
    if (baseUrlElement?.textContent) {
      let baseUrl = baseUrlElement.textContent;
      if (baseUrl.includes('kkbox.com.tw/')) {
        baseUrl = baseUrl.replace('//https:%2F%2F', '//');
      }
      this.baseUrl = combineUrl(this.mpdUrl, baseUrl);
    }

    return manifest;
  }

  appendPeriodTracks(tracks: DashParsedTrack[], manifest: DashManifestInfo, period: Element): void {
    const periodDurationSeconds = Temporal.Duration.from(
      period.getAttribute('duration') || manifest.mediaPresentationDuration || 'PT0S',
    ).total('seconds');
    const periodBaseUrl = extendDashBaseUrl(period, this.baseUrl);

    for (const adaptationSet of getDirectDashChildren(period, 'AdaptationSet')) {
      this.appendAdaptationSetTracks({
        tracks,
        manifest,
        period,
        periodDurationSeconds,
        periodBaseUrl,
        adaptationSet,
      });
    }
  }

  appendAdaptationSetTracks(params: {
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

    for (const representation of getDirectDashChildren(adaptationSet, 'Representation')) {
      const segmentBaseUrl = extendDashBaseUrl(representation, adaptationSetBaseUrl);
      contentType ||= representation.getAttribute('contentType');
      mimeType ||= representation.getAttribute('mimeType');
      const bitrate = Number(representation.getAttribute('bandwidth') ?? '');
      const track = this.createTrack({
        adaptationSet,
        representation,
        period,
        manifest,
        bitrate,
        contentType,
        mimeType,
        frameRate: adaptationSetFrameRate,
      });

      this.populateTrackSegments({
        adaptationSet,
        period,
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

  createTrack(params: {
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
      mimeType,
      period,
      representation,
      timeShiftBufferDepth: manifest.timeShiftBufferDepth,
    });
  }

  populateTrackSegments(params: {
    adaptationSet: Element;
    period: Element;
    representation: Element;
    track: DashParsedTrack;
    manifest: DashManifestInfo;
    segmentBaseUrl: string;
    periodDurationSeconds: number;
    bitrate: number;
  }): void {
    const {
      adaptationSet,
      period,
      representation,
      track,
      manifest,
      segmentBaseUrl,
      periodDurationSeconds,
      bitrate,
    } = params;

    applySegmentBase({ adaptationSet, period, representation, track, segmentBaseUrl });
    applySegmentList({ adaptationSet, period, representation, track, segmentBaseUrl });
    applySegmentTemplate({
      adaptationSet,
      availabilityStartTime: manifest.availabilityStartTime,
      bitrate,
      isLive: manifest.isLive,
      period,
      periodDurationSeconds,
      representationId: representation.getAttribute('id'),
      representation,
      segBaseUrl: segmentBaseUrl,
      track,
      timeShiftBufferDepth: manifest.timeShiftBufferDepth,
    });
    ensureFallbackMediaSegment(track, segmentBaseUrl, periodDurationSeconds);
    normalizeDashTrackExtension(track);
    applyContentProtection(adaptationSet, representation, track);
  }

  findMatchingTrack(
    nextTracks: DashParsedTrack[],
    currentTrack: DashParsedTrack,
  ): DashParsedTrack | undefined {
    let matchingTracks = nextTracks.filter(
      (candidate) => getDashTrackMatchKey(candidate) === getDashTrackMatchKey(currentTrack),
    );
    if (!matchingTracks.length) {
      matchingTracks = nextTracks.filter(
        (candidate) => candidate.initSegment?.url === currentTrack.initSegment?.url,
      );
    }

    return matchingTracks[0];
  }

  async refreshTracks(tracks: DashParsedTrack[]): Promise<void> {
    if (!tracks.length) {
      return;
    }

    const response = await this.fetchManifest(this.manifestUrl).catch(() =>
      this.fetchManifest(this.originalUrl),
    );
    const rawText = await response.text();

    this.manifestUrl = response.url;
    this.resetManifestUrls();

    const nextTracks = this.extractTracks(rawText);
    for (const track of tracks) {
      const nextTrack = this.findMatchingTrack(nextTracks, track);
      if (!nextTrack) {
        continue;
      }

      track.isLive = nextTrack.isLive;
      track.refreshIntervalMs = nextTrack.refreshIntervalMs;
      track.initSegment = nextTrack.initSegment;
      track.mediaSegments = nextTrack.mediaSegments;
      track.audioGroupId = nextTrack.audioGroupId;
      track.subtitleGroupId = nextTrack.subtitleGroupId;
    }
  }

  async fetchManifest(url: string) {
    const response = await fetch(url, { headers: this.headers });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch DASH manifest: ${response.status} ${response.statusText} (${response.url})`,
      );
    }
    return response;
  }

  resetManifestUrls() {
    this.mpdUrl = this.manifestUrl;
    this.baseUrl = this.mpdUrl;
  }
}

abstract class DashTrackBackingBase {
  internalTrack: InternalTrack;
  hydratedTrackPromise: Promise<any> | null = null;

  constructor(internalTrack: InternalTrack) {
    this.internalTrack = internalTrack;
  }

  abstract getType(): 'video' | 'audio' | 'subtitle';

  hydrate() {
    return (this.hydratedTrackPromise ??= this.getSegmentedInput().getFirstTrack());
  }

  delegate<T>(fn: (track: any) => T | Promise<T>) {
    if (this.hydratedTrackPromise) {
      return this.hydratedTrackPromise.then(fn);
    }

    return this.hydrate().then(fn);
  }

  getId() {
    return this.internalTrack.id;
  }

  getNumber() {
    return getTrackNumber(this.internalTrack);
  }

  getCodec(): MediaCodec | null {
    return (this.internalTrack.track.codec as MediaCodec | undefined) ?? null;
  }

  getInternalCodecId() {
    return null;
  }

  getName() {
    return this.internalTrack.track.name;
  }

  getLanguageCode() {
    return this.internalTrack.track.languageCode ?? 'und';
  }

  getTimeResolution() {
    return this.delegate((track) => track.getTimeResolution());
  }

  isRelativeToUnixEpoch() {
    return false;
  }

  getDisposition() {
    return getDisposition(this.internalTrack.track);
  }

  getPairingMask() {
    return this.internalTrack.pairingMask;
  }

  getBitrate() {
    return this.internalTrack.track.peakBitrate;
  }

  getAverageBitrate() {
    return this.internalTrack.track.averageBitrate;
  }

  async getDurationFromMetadata(_options: DurationMetadataRequestOptions) {
    return this.internalTrack.track.mediaSegments.reduce(
      (sum, segment) => sum + segment.duration,
      0,
    );
  }

  async getLiveRefreshInterval() {
    if (!this.internalTrack.track.isLive) {
      return null;
    }

    return this.internalTrack.track.refreshIntervalMs / 1000;
  }

  getHasOnlyKeyPackets() {
    return false;
  }

  async getDecoderConfig() {
    return this.getSegmentedInput().getDecoderConfig();
  }

  getMetadataCodecParameterString() {
    return this.internalTrack.track.codecString;
  }

  async getFirstPacket(options: PacketRetrievalOptions) {
    return this.getSegmentedInput().getFirstPacket(options);
  }

  async getPacket(timestamp: number, options: PacketRetrievalOptions) {
    return this.getSegmentedInput().getPacket(timestamp, options);
  }

  async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
    return this.getSegmentedInput().getNextPacket(packet, options);
  }

  async getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
    return this.getSegmentedInput().getKeyPacket(timestamp, options);
  }

  async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
    return this.getSegmentedInput().getNextKeyPacket(packet, options);
  }

  getSegmentedInput() {
    return this.internalTrack.demuxer.getSegmentedInputForTrack(this.internalTrack);
  }

  async getSegments(): Promise<DashSegment[]> {
    const segmentedInput = this.getSegmentedInput();
    await segmentedInput.runUpdateSegments();
    return segmentedInput.segments;
  }
}

class DashInputVideoTrackBacking extends DashTrackBackingBase {
  override internalTrack: InternalVideoTrack;

  constructor(internalTrack: InternalVideoTrack) {
    super(internalTrack);
    this.internalTrack = internalTrack;
  }

  getType() {
    return 'video' as const;
  }

  override getCodec(): VideoCodec | null {
    return (this.internalTrack.track.codec as VideoCodec | null) ?? null;
  }

  getCodedWidth() {
    return this.internalTrack.info.width ?? this.delegate((track) => track.getCodedWidth());
  }

  getCodedHeight() {
    return this.internalTrack.info.height ?? this.delegate((track) => track.getCodedHeight());
  }

  getSquarePixelWidth() {
    return this.internalTrack.info.width ?? this.delegate((track) => track.getSquarePixelWidth());
  }

  getSquarePixelHeight() {
    return this.internalTrack.info.height ?? this.delegate((track) => track.getSquarePixelHeight());
  }

  getMetadataDisplayWidth() {
    return this.internalTrack.info.width;
  }

  getMetadataDisplayHeight() {
    return this.internalTrack.info.height;
  }

  getRotation() {
    return 0;
  }

  async getColorSpace(): Promise<VideoColorSpaceInit> {
    return this.delegate((track) => track.getColorSpace());
  }

  async canBeTransparent() {
    return this.delegate((track) => track.canBeTransparent());
  }
}

class DashInputAudioTrackBacking extends DashTrackBackingBase {
  override internalTrack: InternalAudioTrack;

  constructor(internalTrack: InternalAudioTrack) {
    super(internalTrack);
    this.internalTrack = internalTrack;
  }

  getType() {
    return 'audio' as const;
  }

  override getCodec(): AudioCodec | null {
    return (this.internalTrack.track.codec as AudioCodec | null) ?? null;
  }

  getNumberOfChannels() {
    return this.internalTrack.info.numberOfChannels ?? this.delegate((track) => track.getNumberOfChannels());
  }

  getSampleRate() {
    return this.internalTrack.track.sampleRate ?? this.delegate((track) => track.getSampleRate());
  }
}

class DashInputSubtitleTrackBacking extends DashTrackBackingBase {
  override internalTrack: InternalSubtitleTrack;

  constructor(internalTrack: InternalSubtitleTrack) {
    super(internalTrack);
    this.internalTrack = internalTrack;
  }

  getType() {
    return 'subtitle' as const;
  }
}

type DashInputTrackBacking =
  | DashInputVideoTrackBacking
  | DashInputAudioTrackBacking
  | DashInputSubtitleTrackBacking;

const createTrackBackings = (internalTracks: InternalTrack[]) =>
  internalTracks.map((internalTrack) => {
    const backing =
      internalTrack.info.type === 'video'
        ? new DashInputVideoTrackBacking(internalTrack as InternalVideoTrack)
        : internalTrack.info.type === 'audio'
          ? new DashInputAudioTrackBacking(internalTrack as InternalAudioTrack)
          : new DashInputSubtitleTrackBacking(internalTrack as InternalSubtitleTrack);

    internalTrack.backingTrack = backing;
    return backing;
  });

export class DashInputFormat extends InputFormat {
  get name() {
    return 'Dynamic Adaptive Streaming over HTTP (DASH)';
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

export const DASH = new DashInputFormat();
export const DASH_FORMATS: InputFormat[] = [DASH, MP4, QTFF, WEBM, MATROSKA, MP3, ADTS];
