import { EXTRACTOR_TYPES, ExtractorType } from '../shared/extractor-type';
import { ParserConfig } from '../parser-config';
import { ContentProcessor } from '../processor';
import { HLS_TAGS } from './hls-tags';

export class DefaultHlsContentProcessor extends ContentProcessor {
  private static readonly YkDVRegex =
    /#EXT-X-DISCONTINUITY\s+#EXT-X-MAP:URI="(.*?)",BYTERANGE="(.*?)"/g;
  private static readonly DNSPRegex = /#EXT-X-MAP:URI=".*?BUMPER\/[\s\S]+?#EXT-X-DISCONTINUITY/;
  private static readonly DNSPSubRegex = /#EXTINF:.*?,\s+.*BUMPER.*\s+#EXT-X-DISCONTINUITY/;
  private static readonly OrderFixRegex = /(#EXTINF.*)(\s+)(#EXT-X-KEY.*)/g;
  private static readonly ATVRegex = /#EXT-X-MAP.*\.apple\.com\//;
  private static readonly ATVRegex2 = /(#EXT-X-KEY:[\s\S]*?)(#EXT-X-DISCONTINUITY|#EXT-X-ENDLIST)/;

  canProcess(extractorType: ExtractorType): boolean {
    return extractorType === EXTRACTOR_TYPES.HLS;
  }

  process(m3u8Content: string, parserConfig: ParserConfig): string {
    // Normalize line endings
    if (m3u8Content.includes('\r') && !m3u8Content.includes('\n')) {
      m3u8Content = m3u8Content.replace(/\r/g, '\n');
    }

    const m3u8Url = parserConfig.url;

    // YSP playback
    if (m3u8Url.includes('tlivecloud-playback-cdn.ysp.cctv.cn') && m3u8Url.includes('endtime=')) {
      m3u8Content += '\n' + HLS_TAGS.extXEndlist;
    }

    // YK DV fix
    if (
      m3u8Content.includes('#EXT-X-DISCONTINUITY') &&
      m3u8Content.includes('#EXT-X-MAP') &&
      m3u8Content.includes('ott.cibntv.net') &&
      m3u8Content.includes('ccode=')
    ) {
      m3u8Content = m3u8Content.replace(
        DefaultHlsContentProcessor.YkDVRegex,
        (_match, uri, byterange) => `#EXTINF:0.000000,\n#EXT-X-BYTERANGE:${byterange}\n${uri}`,
      );
    }

    // Disney+ main fix
    if (
      m3u8Content.includes('#EXT-X-DISCONTINUITY') &&
      m3u8Content.includes('#EXT-X-MAP') &&
      m3u8Url.includes('media.dssott.com/')
    ) {
      this.applyRegexReplacement(m3u8Content, DefaultHlsContentProcessor.DNSPRegex);
    }

    // Disney+ subtitle fix
    if (
      m3u8Content.includes('#EXT-X-DISCONTINUITY') &&
      m3u8Content.includes('seg_00000.vtt') &&
      m3u8Url.includes('media.dssott.com/')
    ) {
      this.applyRegexReplacement(m3u8Content, DefaultHlsContentProcessor.DNSPSubRegex);
    }

    // Apple TV fix
    if (
      m3u8Content.includes('#EXT-X-DISCONTINUITY') &&
      m3u8Content.includes('#EXT-X-MAP') &&
      (m3u8Url.includes('.apple.com/') || DefaultHlsContentProcessor.ATVRegex.test(m3u8Content))
    ) {
      const match = DefaultHlsContentProcessor.ATVRegex2.exec(m3u8Content);
      if (match) {
        m3u8Content = `#EXTM3U\n${match[1]}\n#EXT-X-ENDLIST`;
      }
    }

    // Order fix
    if (DefaultHlsContentProcessor.OrderFixRegex.test(m3u8Content)) {
      m3u8Content = m3u8Content.replace(DefaultHlsContentProcessor.OrderFixRegex, '$3$2$1');
    }

    return m3u8Content;
  }

  private applyRegexReplacement(content: string, regex: RegExp): string {
    if (regex.test(content)) {
      const match = regex.exec(content);
      if (match) {
        return content.split(match[0]).join('#XXX');
      }
    }
    return content;
  }
}
