import { MediaSegment } from './media-segment';

export class MediaPart {
  mediaSegments: MediaSegment[] = [];

  constructor(segments: MediaSegment[]) {
    this.mediaSegments = segments;
  }
}
