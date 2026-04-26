import { setTimeout as delay } from 'node:timers/promises';
import {
  CustomPathedSource,
  EncodedPacket,
  Input as MediabunnyInput,
  type InputFormat,
  type InputFormatOptions,
  type InputTrack,
  type PacketRetrievalOptions,
  type SourceRef,
  type SourceRequest,
} from 'mediabunny';
import { DASH_MIME_TYPE, type DashEncryptionData, type DashParsedSegment } from './dash-misc';
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

type SegmentRetrievalOptions = {
  skipLiveWait?: boolean;
};

type TrackWithBacking = InputTrack & {
  _backing: {
    getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;
    getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    getNextPacket(
      packet: EncodedPacket,
      options: PacketRetrievalOptions,
    ): Promise<EncodedPacket | null>;
    getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null>;
    getNextKeyPacket(
      packet: EncodedPacket,
      options: PacketRetrievalOptions,
    ): Promise<EncodedPacket | null>;
    getHasOnlyKeyPackets?(): boolean | null | Promise<boolean | null>;
  };
};

type PacketInfo = {
  segment: DashSegment;
  track: TrackWithBacking;
  sourcePacket: EncodedPacket;
};

type InternalMediabunnyInput = MediabunnyInput & {
  _formatOptions: InputFormatOptions;
  _formats: InputFormat[];
  _getSourceCached(request: SourceRequest): Promise<SourceRef>;
};

const roundToDivisor = (value: number, multiple: number) =>
  Math.round(value * multiple) / multiple;

const binarySearchLessOrEqual = <T>(
  array: readonly T[],
  value: number,
  getValue: (entry: T) => number,
) => {
  let left = 0;
  let right = array.length - 1;
  let result = -1;

  while (left <= right) {
    const mid = (left + right) >> 1;
    const midValue = getValue(array[mid]!);

    if (midValue <= value) {
      result = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return result;
};

const getLeastRecentlyUsedIndex = <T extends { age: number }>(entries: readonly T[]) => {
  let bestIndex = -1;
  let bestAge = Infinity;

  for (const [index, entry] of entries.entries()) {
    if (entry.age < bestAge) {
      bestAge = entry.age;
      bestIndex = index;
    }
  }

  return bestIndex;
};

const getSegmentLocation = (segment: DashParsedSegment): DashSegmentLocation => ({
  path: segment.url,
  offset: segment.startRange ?? 0,
  length: segment.expectLength ?? null,
});

const createInitSegment = (segment: DashParsedSegment): DashSegment => ({
  timestamp: 0,
  duration: 0,
  relativeToUnixEpoch: false,
  firstSegment: null,
  sequenceNumber: segment.sequenceNumber,
  location: getSegmentLocation(segment),
  encryption: segment.encryption,
  initSegment: null,
  lastProgramDateTimeSeconds: null,
});

const trackToDashSegments = (internalTrack: DashInternalTrack): DashSegment[] => {
  const mediaSegments = internalTrack.track.mediaSegments;
  if (mediaSegments.length === 0) return [];

  let nextTimestamp = 0;
  const segments: DashSegment[] = [];

  for (const mediaSegment of mediaSegments) {
    const timestamp = mediaSegment.timestamp ?? nextTimestamp;
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
    nextTimestamp = timestamp + mediaSegment.duration;
  }

  const firstSegment = segments[0] ?? null;
  const initSegment = internalTrack.track.initSegment
    ? createInitSegment(internalTrack.track.initSegment)
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

  nextInputCacheAge = 0;
  inputCache: {
    age: number;
    input: MediabunnyInput;
    segment: DashSegment;
  }[] = [];

  firstTrackPromise: Promise<TrackWithBacking> | null = null;
  packetInfos = new WeakMap<EncodedPacket, PacketInfo>();
  firstSegmentFirstTimestamps = new WeakMap<DashSegment, number>();
  firstTimestampCache = new WeakMap<MediabunnyInput, number>();

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
      return 0;
    }

    return result;
  }

  async getFirstSegment() {
    if (this.segments.length === 0) {
      await this.runUpdateSegments();
    }

    return this.segments[0] ?? null;
  }

  async getSegmentAt(timestamp: number, options: SegmentRetrievalOptions) {
    if (this.segments.length === 0) {
      await this.runUpdateSegments();
    }

    let isLazy = !!options.skipLiveWait && this.getRemainingWaitTimeMs() > 0;

    while (true) {
      const index = binarySearchLessOrEqual(this.segments, timestamp, (segment) => segment.timestamp);
      if (index === -1) {
        return null;
      }

      if (index < this.segments.length - 1 || !this.internalTrack.track.isLive || isLazy) {
        return this.segments[index]!;
      }

      const segment = this.segments[index]!;
      if (timestamp < segment.timestamp + segment.duration) {
        return segment;
      }

      await this.runUpdateSegments();

      if (options.skipLiveWait) {
        isLazy = true;
      }
    }
  }

  getNextSegmentIndex(segment: DashSegment) {
    const currentIndex = this.segments.indexOf(segment);
    if (currentIndex !== -1) {
      return currentIndex + 1;
    }

    if (segment.sequenceNumber !== null) {
      const matchingSequenceIndex = this.segments.findIndex(
        (candidate) => candidate.sequenceNumber === segment.sequenceNumber,
      );
      if (matchingSequenceIndex !== -1) {
        return matchingSequenceIndex + 1;
      }

      return this.segments.findIndex(
        (candidate) =>
          candidate.sequenceNumber !== null && candidate.sequenceNumber > segment.sequenceNumber!,
      );
    }

    const matchingLocationIndex = this.segments.findIndex(
      (candidate) =>
        candidate.timestamp === segment.timestamp &&
        candidate.duration === segment.duration &&
        candidate.location.path === segment.location.path &&
        candidate.location.offset === segment.location.offset &&
        candidate.location.length === segment.location.length,
    );
    if (matchingLocationIndex !== -1) {
      return matchingLocationIndex + 1;
    }

    return this.segments.findIndex((candidate) => candidate.timestamp > segment.timestamp);
  }

  async getNextSegment(segment: DashSegment, options: SegmentRetrievalOptions) {
    let isLazy = !!options.skipLiveWait && this.getRemainingWaitTimeMs() > 0;

    while (true) {
      const nextIndex = this.getNextSegmentIndex(segment);
      if (nextIndex !== -1 && nextIndex < this.segments.length) {
        return this.segments[nextIndex]!;
      }

      if (!this.internalTrack.track.isLive || isLazy) {
        return null;
      }

      await this.runUpdateSegments();

      if (options.skipLiveWait) {
        isLazy = true;
      }
    }
  }

  async getPreviousSegment(segment: DashSegment) {
    const index = this.segments.indexOf(segment);
    if (index === -1) {
      throw new Error('Segment was not created by this segmented input.');
    }

    return this.segments[index - 1] ?? null;
  }

  getInputForSegment(segment: DashSegment): MediabunnyInput {
    const input = this.demuxer.input as InternalMediabunnyInput;
    const cacheEntry = this.inputCache.find((entry) => entry.segment === segment);
    if (cacheEntry) {
      cacheEntry.age = this.nextInputCacheAge++;
      return cacheEntry.input;
    }

    let initInput: MediabunnyInput | null = null;
    if (segment.initSegment && segment.initSegment !== segment) {
      initInput = this.getInputForSegment(segment.initSegment);
    }

    const formatOptions: InputFormatOptions = {
      ...input._formatOptions,
    };

    const segmentInput = new MediabunnyInput({
      source: new CustomPathedSource(
        segment.location.path,
        async (request) => {
          if (!request.isRoot) {
            throw new Error('Nested requests are not supported for DASH segments.');
          }

          const proxiedRequest: SourceRequest = {
            ...request,
            isRoot: false,
          };

          let ref: SourceRef = await input._getSourceCached(proxiedRequest);
          const needsSlice = segment.location.offset > 0 || segment.location.length !== null;

          if (needsSlice) {
            const slice = ref.source.slice(segment.location.offset, segment.location.length ?? undefined);
            const sliceRef = slice.ref();
            ref.free();
            ref = sliceRef;
          }

          return ref;
        },
      ),
      formats: input._formats.filter((format) => format.mimeType !== DASH_MIME_TYPE),
      initInput: initInput ?? undefined,
      formatOptions,
    });

    this.inputCache.push({
      age: this.nextInputCacheAge++,
      input: segmentInput,
      segment,
    });

    const maxInputCacheSize = 4;
    if (this.inputCache.length > maxInputCacheSize) {
      const minAgeIndex = getLeastRecentlyUsedIndex(this.inputCache);
      if (minAgeIndex === -1) {
        throw new Error('Failed to evict cached DASH segment input.');
      }
      this.inputCache.splice(minAgeIndex, 1);
    }

    return segmentInput;
  }

  async getTrackForSegment(segment: DashSegment): Promise<TrackWithBacking | null> {
    const input = this.getInputForSegment(segment);
    const tracks = await input.getTracks();
    const matchingType = tracks.filter((track) => track.type === this.internalTrack.info.type);

    if (matchingType.length === 1) {
      return matchingType[0] as TrackWithBacking;
    }

    if (this.internalTrack.track.codec) {
      for (const track of matchingType) {
        if ((await track.getCodec()) === this.internalTrack.track.codec) {
          return track as TrackWithBacking;
        }
      }
    }

    return (matchingType[0] as TrackWithBacking | undefined) ?? null;
  }

  async getFirstTrack(): Promise<TrackWithBacking> {
    return (this.firstTrackPromise ??= (async () => {
      const firstSegment = await this.getFirstSegment();
      if (!firstSegment) {
        throw new Error('Missing first DASH segment, cannot hydrate track.');
      }

      const track = await this.getTrackForSegment(firstSegment);
      if (!track) {
        throw new Error('No matching track found in DASH segment media data.');
      }

      return track;
    })());
  }

  async getFirstTimestampForInput(input: MediabunnyInput) {
    const existing = this.firstTimestampCache.get(input);
    if (existing !== undefined) {
      return existing;
    }

    const firstTimestamp = await input.getFirstTimestamp();
    this.firstTimestampCache.set(input, firstTimestamp);
    return firstTimestamp;
  }

  async getMediaOffset(segment: DashSegment, input: MediabunnyInput, track: InputTrack) {
    const firstSegment = segment.firstSegment ?? segment;

    let firstSegmentFirstTimestamp: number;
    if (this.firstSegmentFirstTimestamps.has(firstSegment)) {
      firstSegmentFirstTimestamp = this.firstSegmentFirstTimestamps.get(firstSegment)!;
    } else {
      const firstInput = this.getInputForSegment(firstSegment);
      firstSegmentFirstTimestamp = await this.getFirstTimestampForInput(firstInput);
      this.firstSegmentFirstTimestamps.set(firstSegment, firstSegmentFirstTimestamp);
    }

    if (firstSegment === segment) {
      return firstSegment.timestamp - firstSegmentFirstTimestamp;
    }

    const segmentFirstTimestamp = await this.getFirstTimestampForInput(input);
    const segmentElapsed = segment.timestamp - firstSegment.timestamp;
    const inputElapsed = segmentFirstTimestamp - firstSegmentFirstTimestamp;
    const difference = inputElapsed - segmentElapsed;

    if (Math.abs(difference) <= Math.min(0.25, segmentElapsed)) {
      return firstSegment.timestamp - firstSegmentFirstTimestamp;
    }

    return segment.timestamp - segmentFirstTimestamp;
  }

  async createAdjustedPacket(
    packet: EncodedPacket,
    segment: DashSegment,
    track: TrackWithBacking,
  ): Promise<EncodedPacket> {
    if (packet.sequenceNumber < 0) {
      throw new Error('DASH packet sequence number must be non-negative.');
    }

    const input = track.input as MediabunnyInput;
    const mediaOffset = await this.getMediaOffset(segment, input, track);
    const firstSegment = segment.firstSegment ?? segment;
    const segmentTimestampRelativeToFirst = segment.timestamp - firstSegment.timestamp;

    const modified = packet.clone({
      timestamp: roundToDivisor(
        packet.timestamp + mediaOffset,
        await track.getTimeResolution(),
      ),
      sequenceNumber: Math.floor(1e8 * segmentTimestampRelativeToFirst) + packet.sequenceNumber,
    });

    this.packetInfos.set(modified, {
      segment,
      track,
      sourcePacket: packet,
    });

    return modified;
  }

  async getDecoderConfig() {
    const track = await this.getFirstTrack();
    return track._backing.getDecoderConfig();
  }

  async getHasOnlyKeyPackets() {
    const track = await this.getFirstTrack();
    return (await track._backing.getHasOnlyKeyPackets?.()) ?? null;
  }

  async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
    const firstSegment = await this.getFirstSegment();
    if (!firstSegment) {
      return null;
    }

    const track = await this.getTrackForSegment(firstSegment);
    if (!track) {
      return null;
    }

    const packet = await track._backing.getFirstPacket(options);
    if (!packet) {
      return null;
    }

    return this.createAdjustedPacket(packet, firstSegment, track);
  }

  getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
    return this.getNextPacketInternal(packet, options, false);
  }

  getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
    return this.getNextPacketInternal(packet, options, true);
  }

  async getNextPacketInternal(
    packet: EncodedPacket,
    options: PacketRetrievalOptions,
    keyframesOnly: boolean,
  ): Promise<EncodedPacket | null> {
    const info = this.packetInfos.get(packet);
    if (!info) {
      throw new Error('Packet was not created from this DASH track.');
    }

    const nextPacket = keyframesOnly
      ? await info.track._backing.getNextKeyPacket(info.sourcePacket, options)
      : await info.track._backing.getNextPacket(info.sourcePacket, options);
    if (nextPacket) {
      return this.createAdjustedPacket(nextPacket, info.segment, info.track);
    }

    let currentSegment: DashSegment | null = info.segment;
    while (true) {
      const nextSegment = await this.getNextSegment(currentSegment, {
        skipLiveWait: options.skipLiveWait,
      });
      if (!nextSegment) {
        return null;
      }

      const nextTrack = await this.getTrackForSegment(nextSegment);
      if (!nextTrack) {
        currentSegment = nextSegment;
        continue;
      }

      const firstPacket = await nextTrack._backing.getFirstPacket(options);
      if (!firstPacket) {
        currentSegment = nextSegment;
        continue;
      }

      return this.createAdjustedPacket(firstPacket, nextSegment, nextTrack);
    }
  }

  getPacket(timestamp: number, options: PacketRetrievalOptions) {
    return this.getPacketInternal(timestamp, options, false);
  }

  getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
    return this.getPacketInternal(timestamp, options, true);
  }

  async getPacketInternal(
    timestamp: number,
    options: PacketRetrievalOptions,
    keyframesOnly: boolean,
  ): Promise<EncodedPacket | null> {
    let currentSegment = await this.getSegmentAt(timestamp, {
      skipLiveWait: options.skipLiveWait,
    });
    if (!currentSegment) {
      return null;
    }

    while (currentSegment) {
      const track = await this.getTrackForSegment(currentSegment);
      if (!track) {
        currentSegment = await this.getPreviousSegment(currentSegment);
        continue;
      }

      const input = track.input as MediabunnyInput;
      const mediaOffset = await this.getMediaOffset(currentSegment, input, track);
      const offsetTimestamp = timestamp - mediaOffset;
      const packet = keyframesOnly
        ? await track._backing.getKeyPacket(offsetTimestamp, options)
        : await track._backing.getPacket(offsetTimestamp, options);

      if (!packet) {
        currentSegment = await this.getPreviousSegment(currentSegment);
        continue;
      }

      return this.createAdjustedPacket(packet, currentSegment, track);
    }

    return null;
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
