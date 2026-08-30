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
}

interface UpdateInput {
  state?: PipelineState;
  progress?: number;
  message?: string;
  error?: string | null;
  martin?: MartinInfo | null;
}

class Status {
  readonly startedAt = new Date().toISOString();
  private state: PipelineState = "checking";
  private progress = 0;
  private message = "Starting";
  private error: string | undefined;
  private martin: MartinInfo | undefined;

  update(input: UpdateInput): void {
    if (input.state !== undefined) this.state = input.state;
    if (input.progress !== undefined) {
      this.progress = Math.max(0, Math.min(100, Math.round(input.progress)));
    }
    if (input.message !== undefined) this.message = input.message;
    if (input.error !== undefined) this.error = input.error ?? undefined;
    if (input.martin !== undefined) this.martin = input.martin ?? undefined;
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
    };
  }
}

export const status = new Status();
