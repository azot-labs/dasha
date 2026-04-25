import { setTimeout as delay } from 'node:timers/promises';
import type { DashEncryptionData, DashParsedSegment } from './dash-misc';
import type { DashInternalTrack } from './dash-track-backing';

export type Segment = {
  timestamp: number;
  duration: number;
  relativeToUnixEpoch: boolean;
  firstSegment: DashSegment | null;
};

export type DashSegmentLocation = {
  path: string;
  offset: number;
  length: number | null;
};

export type DashEncryptionInfo = DashEncryptionData;

export type DashSegment = Segment & {
  sequenceNumber: number | null;
  location: DashSegmentLocation;
  encryption: DashEncryptionInfo | null;
  firstSegment: DashSegment | null;
  initSegment: DashSegment | null;
  lastProgramDateTimeSeconds: number | null;
};

const getSegmentLocation = (segment: DashParsedSegment): DashSegmentLocation => ({
  path: segment.url,
  offset: segment.startRange ?? 0,
  length: segment.expectLength ?? null,
});

const createInitSegment = (
  segment: DashParsedSegment,
  firstSegment: DashSegment | null,
): DashSegment => ({
  timestamp: 0,
  duration: 0,
  relativeToUnixEpoch: false,
  firstSegment,
  sequenceNumber: segment.sequenceNumber,
  location: getSegmentLocation(segment),
  encryption: segment.encryption,
  initSegment: null,
  lastProgramDateTimeSeconds: null,
});

export const trackToDashSegments = (internalTrack: DashInternalTrack): DashSegment[] => {
  const mediaSegments = internalTrack.track.segmentState.mediaSegments;
  if (mediaSegments.length === 0) return [];

  let timestamp = 0;
  const segments: DashSegment[] = [];

  for (const mediaSegment of mediaSegments) {
    const dashSegment: DashSegment = {
      timestamp,
      duration: mediaSegment.duration,
      relativeToUnixEpoch: false,
      firstSegment: null,
      sequenceNumber: mediaSegment.sequenceNumber,
      location: getSegmentLocation(mediaSegment),
      encryption: mediaSegment.encryption,
      initSegment: null,
      lastProgramDateTimeSeconds: null,
    };
    segments.push(dashSegment);
    timestamp += mediaSegment.duration;
  }

  const firstSegment = segments[0] ?? null;
  const initSegment = internalTrack.track.segmentState.initSegment
    ? createInitSegment(internalTrack.track.segmentState.initSegment, firstSegment)
    : null;

  for (const segment of segments) {
    segment.firstSegment = firstSegment;
    segment.initSegment = initSegment;
  }

  return segments;
};

export class DashSegmentedInput {
  segments: DashSegment[] = [];
  currentUpdateSegmentsPromise: Promise<void> | null = null;
  lastSegmentUpdateTime = -Infinity;

  constructor(readonly internalTrack: DashInternalTrack) {}

  runUpdateSegments() {
    return (this.currentUpdateSegmentsPromise ??= (async () => {
      try {
        const remainingWaitTimeMs = this.getRemainingWaitTimeMs();
        if (remainingWaitTimeMs > 0) {
          await delay(remainingWaitTimeMs);
        }

        this.lastSegmentUpdateTime = performance.now();
        await this.internalTrack.demuxer.refreshTrackSegments(this.internalTrack);
        this.segments = trackToDashSegments(this.internalTrack);
      } finally {
        this.currentUpdateSegmentsPromise = null;
      }
    })());
  }

  getRemainingWaitTimeMs() {
    const segmentState = this.internalTrack.track.segmentState;
    if (!segmentState.isLive) {
      return 0;
    }

    const elapsed = performance.now() - this.lastSegmentUpdateTime;
    const result = Math.max(0, segmentState.refreshIntervalMs - elapsed);
    return result <= 50 ? 0 : result;
  }

  async getLiveRefreshInterval() {
    if (this.getRemainingWaitTimeMs() === 0) {
      await this.runUpdateSegments();
    }

    return this.internalTrack.track.segmentState.isLive
      ? this.internalTrack.track.segmentState.refreshIntervalMs / 1000
      : null;
  }
}
