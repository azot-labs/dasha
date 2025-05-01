import { ContentProcessor } from '../processor';
import { EXTRACTOR_TYPES, ExtractorType } from '../shared/extractor-type';

export class DefaultDashContentProcessor extends ContentProcessor {
  canProcess(extractorType: ExtractorType, mpdContent: string): boolean {
    if (extractorType !== EXTRACTOR_TYPES.MPEG_DASH) return false;
    return mpdContent.includes('<mas:') && !mpdContent.includes('xmlns:mas');
  }

  process(mpdContent: string): string {
    console.debug('Fix xigua mpd...');
    mpdContent = mpdContent.replace(
      '<MPD ',
      '<MPD xmlns:mas="urn:marlin:mas:1-0:services:schemas:mpd" ',
    );
    return mpdContent;
  }
}
