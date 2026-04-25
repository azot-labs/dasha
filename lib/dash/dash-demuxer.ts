import { InputFormat } from 'mediabunny';
import type {
  EncodedPacket,
  Input as MediabunnyInput,
  MediaCodec,
  MetadataTags,
  PacketType,
} from 'mediabunny';
import { DashManifestParser } from './dash-manifest-parser';
import {
  DASH_MIME_TYPE,
  getSourceHeaders,
  isDashManifestText,
  isLikelyDashPath,
  loadDashManifest,
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

class DashDemuxer {
  metadataPromise: Promise<void> | null = null;
  trackBackings: DashInputTrackBacking[] | null = null;
  internalTracks: DashInternalTrack[] | null = null;
  segmentedInputs: DashSegmentedInput[] = [];
  parser: DashManifestParser | null = null;

  constructor(readonly input: MediabunnyInput) {}

  readMetadata() {
    return (this.metadataPromise ??= (async () => {
      const { text, url } = await loadDashManifest(this.input.source);
      const parser = new DashManifestParser({
        headers: getSourceHeaders(this.input.source),
        originalUrl: url,
        url,
      });
      const streams = await parser.extractStreams(text.trim());
      const internalTracks = createDashInternalTracks(this, streams);

      this.parser = parser;
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

    if (!track.streamInfo.playlist?.isLive || !this.parser) {
      return;
    }
    if (
      !this.parser.manifestUrl.startsWith('http://') &&
      !this.parser.manifestUrl.startsWith('https://')
    ) {
      return;
    }

    const streams = this.internalTracks?.map((internalTrack) => internalTrack.streamInfo) ?? [];
    await this.parser.refreshPlaylist(streams);
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
