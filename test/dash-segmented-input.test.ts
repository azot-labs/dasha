import type { EncodedPacket } from 'mediabunny';
import { expect, test, vi } from 'vitest';
import { type DashSegment, DashSegmentedInput } from '../src/dash/dash-segmented-input';

const createSegment = (sequenceNumber: number, timestamp: number): DashSegment => ({
  timestamp,
  duration: 2,
  relativeToUnixEpoch: false,
  sequenceNumber,
  location: {
    path: `segment-${sequenceNumber}.m4s`,
    offset: 0,
    length: null,
  },
  encryption: null,
  firstSegment: null,
  initSegment: null,
  lastProgramDateTimeSeconds: null,
});

const createSegmentedInput = (isLive = true) =>
  new DashSegmentedInput({
    demuxer: {},
    info: { type: 'video' },
    track: {
      isLive,
      refreshIntervalMs: 0,
      mediaSegments: [],
    },
  } as any);

test('getNextSegment recomputes the next live segment after a sliding-window refresh', async () => {
  const segmentedInput = createSegmentedInput(true);
  const first = createSegment(1, 0);
  const second = createSegment(2, 2);
  const third = createSegment(3, 4);
  segmentedInput.segments = [first, second, third];

  const refreshedSecond = createSegment(2, 2);
  const refreshedThird = createSegment(3, 4);
  const refreshedFourth = createSegment(4, 6);

  segmentedInput.runUpdateSegments = vi.fn(async () => {
    segmentedInput.segments = [refreshedSecond, refreshedThird, refreshedFourth];
  });

  const nextSegment = await segmentedInput.getNextSegment(third, {});

  expect(segmentedInput.runUpdateSegments).toHaveBeenCalledTimes(1);
  expect(nextSegment).toBe(refreshedFourth);
});

test('getNextPacket skips empty segments and continues to later packets', async () => {
  const segmentedInput = createSegmentedInput(false);
  const currentSegment = createSegment(1, 0);
  const emptySegment = createSegment(2, 2);
  const populatedSegment = createSegment(3, 4);

  const currentPacket = {} as EncodedPacket;
  const sourcePacket = {} as EncodedPacket;
  const sourceFirstPacket = {} as EncodedPacket;
  const adjustedPacket = {} as EncodedPacket;

  const currentTrack = {
    _backing: {
      getNextPacket: vi.fn(async () => null),
    },
  };
  const emptyTrack = {
    _backing: {
      getFirstPacket: vi.fn(async () => null),
    },
  };
  const populatedTrack = {
    _backing: {
      getFirstPacket: vi.fn(async () => sourceFirstPacket),
    },
  };

  segmentedInput.packetInfos.set(currentPacket, {
    segment: currentSegment,
    track: currentTrack as any,
    sourcePacket,
  });

  segmentedInput.getNextSegment = vi
    .fn()
    .mockResolvedValueOnce(emptySegment)
    .mockResolvedValueOnce(populatedSegment);
  segmentedInput.getTrackForSegment = vi.fn(async (segment: DashSegment) => {
    if (segment === emptySegment) {
      return emptyTrack as any;
    }

    if (segment === populatedSegment) {
      return populatedTrack as any;
    }

    return null;
  });
  segmentedInput.createAdjustedPacket = vi.fn(async () => adjustedPacket);

  const nextPacket = await segmentedInput.getNextPacket(currentPacket, {});

  expect(currentTrack._backing.getNextPacket).toHaveBeenCalledTimes(1);
  expect(emptyTrack._backing.getFirstPacket).toHaveBeenCalledTimes(1);
  expect(populatedTrack._backing.getFirstPacket).toHaveBeenCalledTimes(1);
  expect(segmentedInput.getNextSegment).toHaveBeenCalledTimes(2);
  expect(nextPacket).toBe(adjustedPacket);
});
