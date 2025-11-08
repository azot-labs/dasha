import { ExtractorType } from './shared/extractor-type';
import { MediaStreamInfo } from './shared/stream-info';

export interface Extractor {
  extractorType: ExtractorType;

  extractStreams(rawText: string): Promise<MediaStreamInfo[]>;

  fetchPlayList(streamInfos: MediaStreamInfo[]): Promise<void>;
  refreshPlayList(streamInfos: MediaStreamInfo[]): Promise<void>;

  preProcessUrl(url: string): string;

  preProcessContent(): void;
}
