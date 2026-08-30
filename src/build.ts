import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { log } from "./log.js";
import type { Config } from "./config.js";

export interface BuildHooks {
  /** Called with the overall 0–100 progress and a short human-readable message. */
  onProgress(progress: number, message: string): void;
}

export class BuildError extends Error {}

const MAX_MESSAGE_LEN = 300;
const LOG_TAIL_LINES = 40;

export interface StageSpec {
  readonly name: string;
  readonly weight: number;
}

/**
 * Build stages of the openmaptiles profile, in canonical order, with rough
 * time-share weights (from typical planet-scale runs). Used only to map the
 * per-stage percentages planetiler logs onto a single 0–100 progress bar —
 * the exact split is not important, monotonic motion is.
 */
const STAGES: readonly StageSpec[] = [
  { name: "download", weight: 5 },
  { name: "lake_centerlines", weight: 3 },
  { name: "water_polygons", weight: 7 },
  { name: "natural_earth", weight: 3 },
  { name: "osm_pass1", weight: 8 },
  { name: "sort", weight: 15 },
  { name: "osm_pass2", weight: 30 },
  { name: "boundaries", weight: 2 },
  { name: "mbtiles", weight: 27 },
];

/**
 * The mtb-profile build runs only the OSM passes plus the tile write; the
 * write stage is logged as `archive` by planetiler 0.9.3.
 */
export const MTB_STAGES: readonly StageSpec[] = [
  { name: "osm_pass1", weight: 25 },
  { name: "sort", weight: 10 },
  { name: "osm_pass2", weight: 35 },
  { name: "archive", weight: 30 },
];

/**
 * Planetiler log line shapes (verified against planetiler 0.9.3 output):
 *
 *   0:00:13 INF [water_polygons] -  read: [  550   4%   54/s ] write: [ 2.5M 259k/s ]
 *   2:37:51 INF - 	osm_pass1        4m11s cpu:1h57s gc:6s avg:14.6
 *
 * i.e. "<elapsed> <LEVEL> [stage[:substage]] - message" and stage summary
 * lines "<elapsed> <LEVEL> - <stage> <time> ...". This tracker feeds lines
 * and reports the overall progress (monotonically non-decreasing, capped at
 * 99 — the caller sets 100 when the process exits 0).
 */
export class StageTracker {
  private readonly order: readonly string[];
  private readonly weights: ReadonlyMap<string, number>;
  private stage: string | null = null;
  private fraction = 0;
  private lastOverall = 0;

  constructor(stages: readonly StageSpec[] = STAGES) {
    this.order = stages.map((s) => s.name);
    this.weights = new Map(stages.map((s) => [s.name, s.weight]));
  }

  private baseWeight(stage: string): number {
    const i = this.order.indexOf(stage);
    if (i < 0) return 0;
    let sum = 0;
    for (let k = 0; k < i; k++) sum += this.weights.get(this.order[k]!) ?? 0;
    return sum;
  }

  feed(line: string): void {
    const stageMatch = line.match(/^\S+\s+\w+\s+\[([^\]:]+)/);
    if (stageMatch && this.weights.has(stageMatch[1]!)) {
      const stage = stageMatch[1]!;
      if (stage !== this.stage) {
        this.stage = stage;
        this.fraction = 0;
      }
      const percents = line.match(/\d{1,3}%/g);
      if (percents !== null) {
        const last = Number.parseFloat(percents[percents.length - 1]!);
        if (Number.isFinite(last)) this.fraction = Math.min(100, last);
      }
      return;
    }
    // Stage summary line marks the stage as finished.
    const summary = line.match(/^\S+\s+\w+\s+-\s+([a-z0-9_]+)\s+\d/);
    if (summary && summary[1] === this.stage && this.weights.has(summary[1]!)) {
      this.fraction = 100;
    }
  }

  overall(): number {
    if (this.stage !== null) {
      const weight = this.weights.get(this.stage) ?? 0;
      const overall = this.baseWeight(this.stage) + (this.fraction / 100) * weight;
      this.lastOverall = Math.max(this.lastOverall, Math.min(99, overall));
    }
    return Math.round(this.lastOverall);
  }
}

/** Turns a raw planetiler log line into a short status message (or null). */
export function messageFor(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const stageLine = trimmed.match(/^\S+\s+\w+\s+\[([^\]]+)\]\s*-?\s*(.*)$/);
  if (stageLine) {
    const text = `${stageLine[1] ?? ""}: ${(stageLine[2] ?? "").trim()}`.trim();
    return truncate(text);
  }
  const summary = trimmed.match(/^\S+\s+\w+\s+-\s+([a-z0-9_]+)\s+(\d[^\s]*)/);
  if (summary) return `${summary[1]} done (${summary[2]})`;
  // Continuation lines ("cpus: …", "read( 0%) -> …", stack-trace fragments)
  // carry no timestamp — keep the previous message instead of overwriting it.
  return null;
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_LEN ? `${text.slice(0, MAX_MESSAGE_LEN - 3)}...` : text;
}

/** Appends an actionable hint when the JVM ran out of heap space. */
export function withOomHint(message: string, heapMb: number, heapEnv = "PLANETILER_HEAP_MB"): string {
  if (!/OutOfMemoryError|Java heap space|GC overhead limit/.test(message)) return message;
  return `${message}\n\nJava ran out of heap space (-Xmx${heapMb}m). Increase ${heapEnv} to at least ${Math.max(4096, heapMb * 2)} and re-run (the tileset artifact is not written until the build completes, so a re-run is safe).`;
}

/**
 * Runs the self-contained openmaptiles/planetiler-openmaptiles profile jar:
 *
 *   java -Xmx<heap>m -jar <jar> \
 *     --osm_path=<pbf> --output=<mbtiles> --download=true \
 *     --download_dir=<sources> --tmpdir=<tmp> --force=true
 *
 * The jar must not re-download the OSM extract (we pass --osm_path and the
 * file must exist — with --download=true a missing file would make planetiler
 * fetch its *default* extract instead). All log lines are streamed to the
 * app log and to `hooks.onProgress` (indeterminate-friendly: progress only
 * moves forward, message = latest stage line).
 */
export function runPlanetiler(cfg: Config, hooks: BuildHooks): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!existsSync(cfg.planetilerJar)) {
      reject(
        new BuildError(
          `planetiler profile jar not found: ${cfg.planetilerJar} (set PLANETILER_JAR or use the container image)`,
        ),
      );
      return;
    }
    if (!existsSync(cfg.osmFile)) {
      reject(
        new BuildError(
          `OSM extract not found: ${cfg.osmFile} — with --download=true planetiler would download its default extract instead of ours`,
        ),
      );
      return;
    }

    const args = [
      `-Xmx${cfg.planetilerHeapMb}m`,
      "-jar",
      cfg.planetilerJar,
      `--osm_path=${cfg.osmFile}`,
      `--output=${cfg.mbtilesFile}`,
      "--download=true",
      `--download_dir=${cfg.planetilerSourcesDir}`,
      `--tmpdir=${cfg.planetilerTmpDir}`,
      "--force=true",
    ];
    log(`starting planetiler: java ${args.join(" ")}`);

    let proc: ChildProcess;
    try {
      proc = spawn("java", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(new BuildError(`failed to start java: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }

    const tracker = new StageTracker();
    let pendingOut = "";
    let pendingErr = "";
    let lastMessage = "Building tileset with Planetiler";
    const logTail: string[] = [];

    const handleChunk = (stream: "out" | "err") => (chunk: Buffer): void => {
      const pending = (stream === "out" ? pendingOut : pendingErr) + chunk.toString("utf8");
      const lines = pending.split("\n");
      const rest = lines.pop() ?? "";
      if (stream === "out") pendingOut = rest;
      else pendingErr = rest;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        log(`planetiler[${stream}]: ${trimmed}`);
        logTail.push(trimmed);
        if (logTail.length > LOG_TAIL_LINES) logTail.shift();
        tracker.feed(line);
        const message = messageFor(line);
        if (message !== null) lastMessage = message;
        hooks.onProgress(tracker.overall(), lastMessage);
      }
    };

    proc.stdout?.on("data", handleChunk("out"));
    proc.stderr?.on("data", handleChunk("err"));
    proc.on("error", (e) => {
      reject(new BuildError(`failed to start java: ${e.message}`));
    });
    proc.on("exit", (code, signal) => {
      if (code === 0) {
        hooks.onProgress(100, "Build finished — verifying artifact");
        resolve();
      } else {
        const tail = logTail.join("\n");
        const message = withOomHint(
          `planetiler exited code=${code} signal=${signal} — last output:\n${tail}`,
          cfg.planetilerHeapMb,
        );
        reject(new BuildError(message));
      }
    });

    // Do not orphan the JVM if the app dies mid-build.
    attachLifecycleGuards(proc);
  });
}

/**
 * Runs the dedicated mtb-profile jar (decision B1): a small planetiler profile
 * that emits every OSM way with a non-empty mtb:scale as layer `mtb` /
 * attribute `mtb_scale` at z MTB_MINZOOM..14 into its own MTiles file:
 *
 *   java -Xmx<heap>m -jar <mtb-profile.jar> \
 *     --osm_path=<pbf> --output=<mtb.mbtiles> \
 *     --minzoom=<MTB_MINZOOM> --maxzoom=14 \
 *     --tmpdir=<tmp> --force=true
 *
 * Same indeterminate-friendly streaming/progress contract as runPlanetiler,
 * but with the shorter stage set (no shapefile/Natural Earth stages) and the
 * mtb heap / MTB_MINZOOM build parameter. The OSM extract must already exist
 * (the basemap build ran first) — there is no download here.
 */
export function runMtbProfile(cfg: Config, hooks: BuildHooks): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!existsSync(cfg.mtbProfileJar)) {
      reject(
        new BuildError(
          `mtb profile jar not found: ${cfg.mtbProfileJar} (set MTB_PROFILE_JAR or use the container image)`,
        ),
      );
      return;
    }
    if (!existsSync(cfg.osmFile)) {
      reject(
        new BuildError(
          `OSM extract not found: ${cfg.osmFile} — the mtb build reads the same extract as the basemap build`,
        ),
      );
      return;
    }

    const args = [
      `-Xmx${cfg.mtbHeapMb}m`,
      "-jar",
      cfg.mtbProfileJar,
      `--osm_path=${cfg.osmFile}`,
      `--output=${cfg.mtbMbtilesFile}`,
      `--minzoom=${cfg.mtbMinzoom}`,
      "--maxzoom=14",
      `--tmpdir=${cfg.planetilerTmpDir}`,
      "--force=true",
    ];
    log(`starting mtb profile: java ${args.join(" ")}`);

    let proc: ChildProcess;
    try {
      proc = spawn("java", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(new BuildError(`failed to start java: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }

    const tracker = new StageTracker(MTB_STAGES);
    let pendingOut = "";
    let pendingErr = "";
    let lastMessage = "Building MTB tileset with Planetiler";
    const logTail: string[] = [];

    const handleChunk = (stream: "out" | "err") => (chunk: Buffer): void => {
      const pending = (stream === "out" ? pendingOut : pendingErr) + chunk.toString("utf8");
      const lines = pending.split("\n");
      const rest = lines.pop() ?? "";
      if (stream === "out") pendingOut = rest;
      else pendingErr = rest;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        log(`mtb[${stream}]: ${trimmed}`);
        logTail.push(trimmed);
        if (logTail.length > LOG_TAIL_LINES) logTail.shift();
        tracker.feed(line);
        const message = messageFor(line);
        if (message !== null) lastMessage = message;
        hooks.onProgress(tracker.overall(), lastMessage);
      }
    };

    proc.stdout?.on("data", handleChunk("out"));
    proc.stderr?.on("data", handleChunk("err"));
    proc.on("error", (e) => {
      reject(new BuildError(`failed to start java: ${e.message}`));
    });
    proc.on("exit", (code, signal) => {
      if (code === 0) {
        hooks.onProgress(100, "MTB build finished — verifying artifact");
        resolve();
      } else {
        const tail = logTail.join("\n");
        const message = withOomHint(
          `mtb profile exited code=${code} signal=${signal} — last output:\n${tail}`,
          cfg.mtbHeapMb,
          "MTB_HEAP_MB",
        );
        reject(new BuildError(message));
      }
    });

    attachLifecycleGuards(proc);
  });
}

/** Re-arms the "don't orphan the JVM" signal/exit guards for a child process. */
function attachLifecycleGuards(proc: ChildProcess): void {
  const onSignal = (sig: NodeJS.Signals): void => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already dead
    }
    process.kill(process.pid, sig);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("exit", () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already dead
    }
  });
}
