import { MediaPart } from './media-part';
import { MediaSegment } from './media-segment';

export class Playlist {
  url = '';
  isLive = false;
  refreshIntervalMs = 15_000;

  get totalDuration() {
    let result = 0;
    for (const part of this.mediaParts) {
      for (const segment of part.mediaSegments) result += segment.duration;
    }
    return result;
  }

  targetDuration?: number;
  mediaInit?: MediaSegment;
  mediaParts: MediaPart[] = [];
}
