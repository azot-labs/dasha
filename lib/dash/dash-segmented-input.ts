import { setTimeout as delay } from 'node:timers/promises';
import type { EncryptInfo } from '../shared/encrypt-info';
import { ENCRYPT_METHODS } from '../shared/encrypt-method';
import type { MediaSegment } from '../shared/media-segment';
import type { Playlist } from '../shared/playlist';
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

export type DashEncryptionInfo = {
  method: string;
  key: Uint8Array | undefined;
  iv: Uint8Array | undefined;
  drm: EncryptInfo['drm'];
};

export type DashSegment = Segment & {
  sequenceNumber: number | null;
  location: DashSegmentLocation;
  encryption: DashEncryptionInfo | null;
  firstSegment: DashSegment | null;
  initSegment: DashSegment | null;
  lastProgramDateTimeSeconds: number | null;
};

const getSegmentLocation = (segment: MediaSegment): DashSegmentLocation => ({
  path: segment.url,
  offset: segment.startRange ?? 0,
  length: segment.expectLength ?? null,
});

const getSegmentEncryption = (encryptInfo: EncryptInfo): DashEncryptionInfo | null => {
  if (
    encryptInfo.method === ENCRYPT_METHODS.NONE ||
    encryptInfo.method === ENCRYPT_METHODS.UNKNOWN
  ) {
    return null;
  }

  return {
    method: encryptInfo.method,
    key: encryptInfo.key,
    iv: encryptInfo.iv,
    drm: encryptInfo.drm,
  };
};

const createInitSegment = (
  segment: MediaSegment,
  firstSegment: DashSegment | null,
): DashSegment => ({
  timestamp: 0,
  duration: 0,
  relativeToUnixEpoch: false,
  firstSegment,
  sequenceNumber: Number.isFinite(segment.index) ? segment.index : null,
  location: getSegmentLocation(segment),
  encryption: getSegmentEncryption(segment.encryptInfo),
  initSegment: null,
  lastProgramDateTimeSeconds: null,
});

const flattenSegments = (playlist?: Playlist) =>
  playlist?.mediaParts.flatMap((part) => part.mediaSegments) ?? [];

export const playlistToDashSegments = (playlist?: Playlist): DashSegment[] => {
  const mediaSegments = flattenSegments(playlist);
  if (mediaSegments.length === 0) return [];

  let timestamp = 0;
  const segments: DashSegment[] = [];

  for (const mediaSegment of mediaSegments) {
    const dashSegment: DashSegment = {
      timestamp,
      duration: mediaSegment.duration,
      relativeToUnixEpoch: false,
      firstSegment: null,
      sequenceNumber: Number.isFinite(mediaSegment.index) ? mediaSegment.index : null,
      location: getSegmentLocation(mediaSegment),
      encryption: getSegmentEncryption(mediaSegment.encryptInfo),
      initSegment: null,
      lastProgramDateTimeSeconds: null,
    };
    segments.push(dashSegment);
    timestamp += mediaSegment.duration;
  }

  const firstSegment = segments[0] ?? null;
  const initSegment = playlist?.mediaInit
    ? createInitSegment(playlist.mediaInit, firstSegment)
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
        this.segments = playlistToDashSegments(this.internalTrack.streamInfo.playlist);
      } finally {
        this.currentUpdateSegmentsPromise = null;
      }
    })());
  }

  getRemainingWaitTimeMs() {
    const playlist = this.internalTrack.streamInfo.playlist;
    if (!playlist?.isLive) {
      return 0;
    }

    const elapsed = performance.now() - this.lastSegmentUpdateTime;
    const result = Math.max(0, playlist.refreshIntervalMs - elapsed);
    return result <= 50 ? 0 : result;
  }

  async getLiveRefreshInterval() {
    if (this.getRemainingWaitTimeMs() === 0) {
      await this.runUpdateSegments();
    }

    const playlist = this.internalTrack.streamInfo.playlist;
    if (!playlist?.isLive) {
      return null;
    }

    return playlist.refreshIntervalMs / 1000;
  }
}
