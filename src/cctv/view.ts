// view.ts — what GET api/cctv returns: the cameras Frigate records and the episodes it
// kept (its review items: something it tracked, or a manual event such as a movement
// sensor's). The pictures and clips are not in it: the panel loads them through the
// api/cctv/* routes, which pass Frigate's answers through. Pure types: the panel imports them.

export interface CctvCamera {
  /** Frigate's camera name, as in its config. */
  name: string;
}

export interface CctvEpisode {
  /** Frigate's review item id. */
  id: string;
  camera: string;
  /** ms epoch. */
  start: number;
  /** ms epoch; null while it is still going on. */
  end: number | null;
  /** "alert": a label Frigate alerts on (a person, a manual event); "detection": anything else it tracked. */
  severity: "alert" | "detection";
  /** What was seen: "person", "cat", a manual event's label ("movement: outside"). */
  labels: string[];
  /** Zones it passed through. */
  zones: string[];
  reviewed: boolean;
}

export type CctvView =
  | { available: false; reason: string }
  | {
      available: true;
      /** Frigate's version. */
      version: string;
      cameras: CctvCamera[];
      /** Newest first. */
      episodes: CctvEpisode[];
      /** There are older ones: ask again with before = the last episode's start. */
      more: boolean;
    };
