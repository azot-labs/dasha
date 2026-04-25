export type Segment = {
  timestamp: number;
  duration: number;
  relativeToUnixEpoch: boolean;
  firstSegment: Segment | null;
};

export type HlsSegmentLocation = {
  path: string;
  offset: number;
  length: number | null;
};

export type HlsEncryptionInfo =
  | {
      method: 'AES-128';
      keyUri: string;
      iv: Uint8Array | null;
      keyFormat: string;
    }
  | {
      method: 'SAMPLE-AES' | 'SAMPLE-AES-CTR';
    };

export type HlsSegment = Segment & {
  sequenceNumber: number | null;
  location: HlsSegmentLocation;
  encryption: HlsEncryptionInfo | null;
  firstSegment: HlsSegment | null;
  initSegment: HlsSegment | null;
  lastProgramDateTimeSeconds: number | null;
};

export type HlsSegmentedInput = {
  segments: HlsSegment[];
  runUpdateSegments(): Promise<void>;
};

export type InputTrackWithBacking = InputTrack & {
  _backing: {
    internalTrack: {
      fullPath: string;
      demuxer: {
        getSegmentedInputForPath(path: string): HlsSegmentedInput;
      };
    };
  };
};
