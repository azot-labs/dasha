import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ExtractorType } from './shared/extractor-type';
import { ParserConfig } from './config/parser-config';
import { Extractor } from './extractor/extractor';
import { HLS_TAGS } from './shared/hls-tags';
import { DashExtractor } from './extractor/dash-extractor';
import { StreamSpec } from './shared/stream-spec';
import { HlsExtractor } from './extractor/hls-extractor';

export class StreamExtractor {
  #extractor!: Extractor;
  #rawText!: string;

  #parserConfig: ParserConfig;
  #rawFiles: Record<string, string> = {};

  constructor(parserConfig?: ParserConfig) {
    this.#parserConfig = parserConfig ?? new ParserConfig();
  }

  get extractorType(): ExtractorType {
    return this.#extractor.extractorType;
  }

  #setUrl(url: string) {
    this.#parserConfig.originalUrl = url;
    this.#parserConfig.url = url;
  }

  async loadSourceFromUrl(url: string) {
    if (url.startsWith('file:')) {
      const uri = new URL(url);
      const filePath = uri.pathname;
      this.#rawText = await readFile(filePath, 'utf8');
      this.#setUrl(url);
    } else if (url.startsWith('http')) {
      this.#parserConfig.originalUrl = url;
      const response = await fetch(url, {
        headers: this.#parserConfig.headers,
      });
      this.#rawText = await response.text();
      this.#parserConfig.url = response.url;
    } else if (existsSync(url)) {
      const filePath = path.resolve(url);
      this.#rawText = await readFile(filePath, 'utf8');
      const absoluteUri = pathToFileURL(filePath).toString();
      this.#setUrl(absoluteUri);
    }
    this.#rawText = this.#rawText.trim();
    await this.loadSourceFromText(this.#rawText);
  }

  async loadSourceFromText(rawText: string, url?: string) {
    if (url) this.#setUrl(url);
    let rawType = 'txt';
    this.#rawText = rawText.trim();
    if (this.#rawText.startsWith(HLS_TAGS.extM3u)) {
      this.#extractor = new HlsExtractor(this.#parserConfig);
      rawType = 'm3u8';
    } else if (this.#rawText.includes('</MPD>') && this.#rawText.includes('<MPD')) {
      this.#extractor = new DashExtractor(this.#parserConfig);
      rawType = 'mpd';
    } else if (
      this.#rawText.includes('</SmoothStreamingMedia>') &&
      this.#rawText.includes('<SmoothStreamingMedia')
    ) {
      // TODO: Implement Smooth Streaming extractor
      rawType = 'ism';
    } else if (rawText === '<RE_LIVE_TS>') {
      // TODO: Implement Live TS extractor
    } else {
      throw new Error('Unsupported stream type');
    }
    this.#rawFiles[`raw.${rawType}`] = rawText;
  }

  async extractStreams() {
    return this.#extractor.extractStreams(this.#rawText);
  }

  async fetchPlayList(streamSpecs: StreamSpec[]): Promise<void> {
    return this.#extractor.fetchPlayList(streamSpecs);
  }

  async refreshPlayList(streamSpecs: StreamSpec[]): Promise<void> {
    return this.#extractor.refreshPlayList(streamSpecs);
  }
}
