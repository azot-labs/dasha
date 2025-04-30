import { EncryptMethod } from '../shared/encrypt-method';

export class ParserConfig {
  url: string = '';
  originalUrl: string = '';
  baseUrl?: string;
  customParserArgs: Record<string, string> = {};
  headers: Record<string, string> = {};
  contentProcessors: any[] = [];
  urlProcessors: any[] = [];
  keyProcessors: any[] = [];

  customMethod?: EncryptMethod;
  customKey?: Buffer;
  customIv?: Buffer;
  urlProcessorArgs?: string;

  appendUrlParams: boolean = false;
  keyRetryCount: number = 3;
}
