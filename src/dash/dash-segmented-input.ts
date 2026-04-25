import { setTimeout as delay } from 'node:timers/promises';
import type { DashEncryptionData, DashParsedSegment } from './dash-misc';
import type { DashInternalTrack } from './dash-demuxer';

export type Segment = {
  timestamp: number;
  duration: number;
  relativeToUnixEpoch: boolean;
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

const trackToDashSegments = (internalTrack: DashInternalTrack): DashSegment[] => {
  const mediaSegments = internalTrack.track.mediaSegments;
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
  const initSegment = internalTrack.track.initSegment
    ? createInitSegment(internalTrack.track.initSegment, firstSegment)
    : null;

  for (const segment of segments) {
    segment.firstSegment = firstSegment;
    segment.initSegment = initSegment;
  }

  return segments;
};

export class DashSegmentedInput {
  internalTrack: DashInternalTrack;
  demuxer: DashInternalTrack['demuxer'];
  segments: DashSegment[] = [];
  currentUpdateSegmentsPromise: Promise<void> | null = null;
  lastSegmentUpdateTime = -Infinity;

  constructor(internalTrack: DashInternalTrack) {
    this.internalTrack = internalTrack;
    this.demuxer = internalTrack.demuxer;
  }

  runUpdateSegments() {
    return (this.currentUpdateSegmentsPromise ??= (async () => {
      try {
        const remainingWaitTimeMs = this.getRemainingWaitTimeMs();
        if (remainingWaitTimeMs > 0) {
          await delay(remainingWaitTimeMs);
        }

        this.lastSegmentUpdateTime = performance.now();
        await this.updateSegments();
      } finally {
        this.currentUpdateSegmentsPromise = null;
      }
    })());
  }

  async updateSegments() {
    await this.demuxer.refreshTrackSegments(this.internalTrack);
    this.segments = trackToDashSegments(this.internalTrack);
  }

  getRemainingWaitTimeMs() {
    if (!this.internalTrack.track.isLive) {
      return 0;
    }

    const elapsed = performance.now() - this.lastSegmentUpdateTime;
    const result = Math.max(0, this.internalTrack.track.refreshIntervalMs - elapsed);
    if (result <= 50) {
      // Match HLS behaviour: skip tiny waits to avoid timing races around live refreshes.
      return 0;
    }

    return result;
  }

  async getLiveRefreshInterval() {
    if (this.getRemainingWaitTimeMs() === 0) {
      await this.runUpdateSegments();
    }

    return this.internalTrack.track.isLive
      ? this.internalTrack.track.refreshIntervalMs / 1000
      : null;
  }
}
