export type PipelineState =
  | "checking"
  | "downloading"
  | "building"
  | "starting"
  | "ready"
  | "error";

export interface MartinInfo {
  url: string;
  /** The MBTiles source ID the style references ("openmaptiles"; verified at startup). */
  source: string;
  /** MVT layers of that source (verified at startup: all required layers present). */
  layers: string[];
  /** The dedicated low-zoom MTB overlay source (step 11), verified at startup. */
  mtb?: {
    source: string;
    layer: string;
    /** The build-time MTB_MINZOOM — the overlay's display minzoom. */
    minzoom: number;
    /**
     * Whether the tileset carries bike-park trails (mtb:scale:imba) — true
     * when built by profile v2 with at least one bike-park way. Lets the UI
     * know whether the bike-park toggle has data to show.
     */
    hasBikePark?: boolean;
    /** The mtb-profile version that built the tileset (e.g. "2"), if recorded. */
    profileVersion?: string;
  };
}

export interface StatusSnapshot {
  state: PipelineState;
  progress: number;
  message: string;
  startedAt: string;
  elapsed: number;
  error?: string;
  martin?: MartinInfo;
  /** Display name of the country the extract covers (workstream D). */
  name?: string;
  /**
   * The OSM data date, "YYYY-MM-DD" (workstream A) — when the extract was
   * produced (its replication / create timestamp, or the file mtime).
   */
  dataDate?: string;
  /** The tileset bounds [west, south, east, north] (workstream D). */
  bounds?: [number, number, number, number];
  /** The tileset center [longitude, latitude, zoom] (workstream D). */
  center?: [number, number, number];
}

interface UpdateInput {
  state?: PipelineState;
  progress?: number;
  message?: string;
  error?: string | null;
  martin?: MartinInfo | null;
  name?: string | null;
  dataDate?: string | null;
  bounds?: [number, number, number, number] | null;
  center?: [number, number, number] | null;
}

class Status {
  readonly startedAt = new Date().toISOString();
  private state: PipelineState = "checking";
  private progress = 0;
  private message = "Starting";
  private error: string | undefined;
  private martin: MartinInfo | undefined;
  private name: string | undefined;
  private dataDate: string | undefined;
  private bounds: [number, number, number, number] | undefined;
  private center: [number, number, number] | undefined;

  update(input: UpdateInput): void {
    if (input.state !== undefined) this.state = input.state;
    if (input.progress !== undefined) {
      this.progress = Math.max(0, Math.min(100, Math.round(input.progress)));
    }
    if (input.message !== undefined) this.message = input.message;
    if (input.error !== undefined) this.error = input.error ?? undefined;
    if (input.martin !== undefined) this.martin = input.martin ?? undefined;
    if (input.name !== undefined) this.name = input.name ?? undefined;
    if (input.dataDate !== undefined) this.dataDate = input.dataDate ?? undefined;
    if (input.bounds !== undefined) this.bounds = input.bounds ?? undefined;
    if (input.center !== undefined) this.center = input.center ?? undefined;
  }

  snapshot(): StatusSnapshot {
    return {
      state: this.state,
      progress: this.progress,
      message: this.message,
      startedAt: this.startedAt,
      elapsed: Math.max(0, Math.round((Date.now() - Date.parse(this.startedAt)) / 1000)),
      ...(this.error !== undefined ? { error: this.error } : {}),
      ...(this.martin !== undefined ? { martin: this.martin } : {}),
      ...(this.name !== undefined ? { name: this.name } : {}),
      ...(this.dataDate !== undefined ? { dataDate: this.dataDate } : {}),
      ...(this.bounds !== undefined ? { bounds: this.bounds } : {}),
      ...(this.center !== undefined ? { center: this.center } : {}),
    };
  }
}

export const status = new Status();
