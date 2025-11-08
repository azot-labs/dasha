import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ExtractorType } from './shared/extractor-type';
import { ParserConfig } from './parser-config';
import { Extractor } from './extractor';
import { HLS_TAGS } from './hls/hls-tags';
import { DashExtractor } from './dash/dash-extractor';
import { MediaStreamInfo } from './shared/stream-info';
import { HlsExtractor } from './hls/hls-extractor';

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
    this.loadSourceFromText(this.#rawText);
  }

  loadSourceFromText(rawText: string, url?: string) {
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
      throw new Error('Smooth Streaming is not supported yet');
    } else if (rawText === '<RE_LIVE_TS>') {
      // TODO: Implement Live TS extractor
      throw new Error('Live TS is not supported yet');
    } else {
      throw new Error('Unsupported stream type');
    }
    this.#rawFiles[`raw.${rawType}`] = rawText;
  }

  async extractStreams() {
    return this.#extractor.extractStreams(this.#rawText);
  }

  async fetchPlayList(streamInfos: MediaStreamInfo[]): Promise<void> {
    return this.#extractor.fetchPlayList(streamInfos);
  }

  async refreshPlayList(streamInfos: MediaStreamInfo[]): Promise<void> {
    return this.#extractor.refreshPlayList(streamInfos);
  }
}
