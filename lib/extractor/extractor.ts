import { ExtractorType } from '../shared/extractor-type';
import { StreamSpec } from '../shared/stream-spec';

export interface Extractor {
  extractorType: ExtractorType;

  extractStreams(rawText: string): Promise<StreamSpec[]>;

  fetchPlayList(streamSpecs: StreamSpec[]): Promise<void>;
  refreshPlayList(streamSpecs: StreamSpec[]): Promise<void>;

  preProcessUrl(url: string): string;

  preProcessContent(): void;
}
