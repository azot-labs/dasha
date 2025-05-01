import { EncryptMethod } from './shared/encrypt-method';
import { ContentProcessor, KeyProcessor, UrlProcessor, DefaultUrlProcessor } from './processor';
import { DefaultDashContentProcessor } from './dash/dash-content-processor';
import { DefaultHlsContentProcessor } from './hls/hls-content-processor';
import { DefaultHlsKeyProcessor } from './hls/hls-key-processor';

export class ParserConfig {
  url: string = '';
  originalUrl: string = '';
  baseUrl?: string;
  customParserArgs: Record<string, string> = {};
  headers: Record<string, string> = {};

  contentProcessors: ContentProcessor[] = [
    new DefaultDashContentProcessor(),
    new DefaultHlsContentProcessor(),
  ];
  urlProcessors: UrlProcessor[] = [new DefaultUrlProcessor()];
  keyProcessors: KeyProcessor[] = [new DefaultHlsKeyProcessor()];

  customMethod?: EncryptMethod;
  customKey?: Buffer;
  customIv?: Buffer;
  urlProcessorArgs?: string;

  appendUrlParams: boolean = false;
  keyRetryCount: number = 3;
}
