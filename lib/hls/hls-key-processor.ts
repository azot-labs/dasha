import { existsSync, readFileSync } from 'node:fs';
import { KeyProcessor } from '../processor';
import { EXTRACTOR_TYPES, ExtractorType } from '../shared/extractor-type';
import { ParserConfig } from '../parser-config';
import { EncryptInfo } from '../shared/encrypt-info';
import { ENCRYPT_METHODS } from '../shared/encrypt-method';

export class DefaultHlsKeyProcessor extends KeyProcessor {
  canProcess(extractorType: ExtractorType): boolean {
    return extractorType === EXTRACTOR_TYPES.HLS;
  }

  async process(
    keyLine: string,
    m3u8Url: string,
    _m3u8Content: string,
    parserConfig: ParserConfig,
  ): Promise<EncryptInfo> {
    const iv = this.getAttribute(keyLine, 'IV');
    const method = this.getAttribute(keyLine, 'METHOD');
    const uri = this.getAttribute(keyLine, 'URI');

    console.debug(`METHOD:${method}, URI:${uri}, IV:${iv}`);

    const encryptInfo = new EncryptInfo(method);

    // Handle IV
    if (iv) {
      encryptInfo.iv = Buffer.from(iv, 'hex');
    }
    if (parserConfig.customIv && parserConfig.customIv.length > 0) {
      encryptInfo.iv = parserConfig.customIv;
    }

    // Handle KEY
    try {
      if (parserConfig.customKey && parserConfig.customKey.length > 0) {
        encryptInfo.key = parserConfig.customKey;
      } else if (uri) {
        const lowerUri = uri.toLowerCase();

        if (lowerUri.startsWith('base64:')) {
          encryptInfo.key = Buffer.from(uri.slice(7), 'base64');
        } else if (lowerUri.startsWith('data:;base64,')) {
          encryptInfo.key = Buffer.from(uri.slice(13), 'base64');
        } else if (lowerUri.startsWith('data:text/plain;base64,')) {
          encryptInfo.key = Buffer.from(uri.slice(23), 'base64');
        } else if (existsSync(uri)) {
          encryptInfo.key = readFileSync(uri);
        } else {
          const processedUrl = this.preProcessUrl(new URL(uri, m3u8Url).toString(), parserConfig);
          encryptInfo.key = await this.fetchKeyWithRetry(processedUrl, parserConfig);
        }
      }
    } catch (error) {
      console.error(`Failed to load key: ${(error as Error).message}`);
      encryptInfo.method = ENCRYPT_METHODS.UNKNOWN;
    }

    // Handle custom encryption method
    if (parserConfig.customMethod) {
      console.warn(`METHOD changed from ${encryptInfo.method} to ${parserConfig.customMethod}`);
      encryptInfo.method = parserConfig.customMethod;
    }

    return encryptInfo;
  }

  private getAttribute(line: string, attrName: string): string | null {
    const regex = new RegExp(`${attrName}="([^"]+)"`, 'i');
    const match = line.match(regex);
    return match?.[1] ?? null;
  }

  private async fetchKeyWithRetry(url: string, parserConfig: ParserConfig): Promise<Buffer> {
    let retryCount = parserConfig.keyRetryCount ?? 3;

    while (retryCount >= 0) {
      try {
        const response = await fetch(url, { headers: parserConfig.headers });
        return Buffer.from(await response.arrayBuffer());
      } catch (error: any) {
        if (error.message.includes('scheme is not supported')) throw error;

        console.warn(`Error fetching key: ${error.message}. Retries left: ${retryCount}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        retryCount--;
      }
    }
    throw new Error('Maximum retry attempts reached');
  }

  private preProcessUrl(url: string, parserConfig: ParserConfig): string {
    let processedUrl = url;
    for (const processor of parserConfig.urlProcessors ?? []) {
      if (processor.canProcess(EXTRACTOR_TYPES.HLS, processedUrl, parserConfig)) {
        processedUrl = processor.process(processedUrl, parserConfig);
      }
    }
    return processedUrl;
  }
}
