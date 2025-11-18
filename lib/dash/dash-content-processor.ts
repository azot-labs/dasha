import { ContentProcessor } from '../processor';
import { EXTRACTOR_TYPES, ExtractorType } from '../shared/extractor-type';

const namespaceMap = new Map([
  ['cenc', 'urn:mpeg:cenc:2013'],
  ['mspr', 'urn:microsoft:playready'],
  ['mas', 'urn:marlin:mas:1-0:services:schemas:mpd'],
]);

const isMissingNs = (rawText: string, tag: string) =>
  !rawText.includes(`xmlns:${tag}`) && rawText.includes(`<${tag}:`);

// Replace the first occurrence of a substring in a string.
function replaceFirst(source: string, oldValue: string, newValue: string): string {
  const index = source.indexOf(oldValue);
  return index < 0
    ? source
    : source.slice(0, index) + newValue + source.slice(index + oldValue.length);
}

export class DefaultDashContentProcessor implements ContentProcessor {
  canProcess(extractorType: ExtractorType, mpdContent: string): boolean {
    if (extractorType !== EXTRACTOR_TYPES.MPEG_DASH) return false;
    return namespaceMap.keys().some((key) => isMissingNs(mpdContent, key));
  }

  process(mpdContent: string): string {
    console.debug('Namespace missing, trying to fix...');
    const missingNamespaceKeys = Array.from(
      namespaceMap.keys().filter((key) => isMissingNs(mpdContent, key)),
    );
    if (!missingNamespaceKeys.length) return mpdContent;
    const missingNamespaceDfns = missingNamespaceKeys.map(
      (key) => `xmlns:${key}="${namespaceMap.get(key)}"`,
    );
    const declarations = missingNamespaceDfns.join(' ');
    return replaceFirst(mpdContent, '<MPD ', `<MPD ${declarations} `);
  }
}
