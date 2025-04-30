import { MediaType } from './media-type';
import { Playlist } from './playlist';
import { RoleType } from './role-type';

export class StreamSpec {
  mediaType?: MediaType;
  groupId: string | null = null;
  language?: string;
  name?: string;
  default?: boolean;

  skippedDuration?: number;

  bandwidth?: number;
  codecs: string | null = null;
  resolution?: string;
  frameRate?: number;
  channels: string | null = null;
  extension: string | null = null;

  // DASH
  role?: RoleType;

  videoRange?: string;
  characteristics?: string;
  publishTime?: Date;

  audioId?: string;
  videoId?: string;
  subtitleId?: string;

  periodId: string | null = null;

  url: string = '';
  originalUrl: string = '';

  playlist?: Playlist;

  get segmentsCount(): number {
    return (
      this.playlist?.mediaParts.reduce(
        (sum, part) => sum + part.mediaSegments.length,
        0,
      ) ?? 0
    );
  }
}
