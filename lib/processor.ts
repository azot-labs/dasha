import { ParserConfig } from './parser-config';
import { ExtractorType } from './shared/extractor-type';
import { EncryptInfo } from './shared/encrypt-info';

export abstract class ContentProcessor {
  abstract canProcess(
    extractorType: ExtractorType,
    rawText: string,
    parserConfig: ParserConfig,
  ): boolean;
  abstract process(rawText: string, parserConfig: ParserConfig): string;
}

export abstract class KeyProcessor {
  abstract canProcess(
    extractorType: ExtractorType,
    keyLine: string,
    m3u8Url: string,
    m3u8Content: string,
    parserConfig: ParserConfig,
  ): boolean;
  abstract process(
    keyLine: string,
    m3u8Url: string,
    m3u8Content: string,
    parserConfig: ParserConfig,
  ): Promise<EncryptInfo>;
}

export abstract class UrlProcessor {
  abstract canProcess(
    extractorType: ExtractorType,
    originalUrl: string,
    parserConfig: ParserConfig,
  ): boolean;
  abstract process(originalUrl: string, parserConfig: ParserConfig): string;
}

export class DefaultUrlProcessor extends UrlProcessor {
  canProcess(_extractorType: ExtractorType, _originalUrl: string, parserConfig: ParserConfig) {
    return parserConfig.appendUrlParams;
  }

  process(url: string, parserConfig: ParserConfig): string {
    if (!url.startsWith('http')) return url;

    const urlFromConfig = new URL(parserConfig.url);
    const urlFromConfigQuery = urlFromConfig.searchParams;

    const oldUrl = new URL(url);
    const newQuery = oldUrl.searchParams;

    for (const [key, value] of urlFromConfigQuery) {
      if (newQuery.has(key)) {
        newQuery.set(key, value);
      } else {
        newQuery.append(key, value);
      }
    }

    if (!newQuery.toString()) return url;

    console.debug(`Before: ${url}`);
    url = `${oldUrl.pathname}?${newQuery.toString()}`;
    console.debug(`After: ${url}`);

    return url;
  }
}
