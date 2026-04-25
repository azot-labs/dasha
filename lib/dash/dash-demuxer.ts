import { InputFormat } from 'mediabunny';
import type {
  EncodedPacket,
  Input as MediabunnyInput,
  MediaCodec,
  MetadataTags,
  PacketType,
} from 'mediabunny';
import {
  DASH_MIME_TYPE,
  isDashManifestText,
  isLikelyDashPath,
  loadDashManifest,
} from './dash-misc';
import { type DashSegment, DashSegmentedInput } from './dash-segmented-input';
import { DashSession } from './dash-track-backing';

export type { DashSegment } from './dash-segmented-input';
export { DashSegmentedInput } from './dash-segmented-input';

class DashDemuxer {
  input: MediabunnyInput;

  #session: DashSession;

  constructor(input: MediabunnyInput) {
    this.input = input;
    this.#session = new DashSession(input.source);
  }

  async getTrackBackings() {
    const { trackBackings } = await this.#session.load();
    return trackBackings;
  }

  async getMimeType() {
    return DASH.mimeType;
  }

  async getMetadataTags(): Promise<MetadataTags> {
    return {};
  }

  dispose() {
    this.#session.dispose();
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
