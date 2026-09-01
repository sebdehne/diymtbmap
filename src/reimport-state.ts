import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { log } from "./log.js";

/**
 * Persistence for the on-demand re-import: the once-per-day anti-spam record
 * (`last-reimport.json`, in the data dir) plus boot-time cleanup of any staging
 * MBTiles left behind by a crashed / interrupted re-import.
 *
 * The record is the anti-spam commit point: it is written the moment an attempt
 * *begins* (result `running`), so a repeat trigger the same day is refused
 * (`alreadyAttemptedToday`) before the data server is contacted again. Reset by
 * deleting the file.
 */

/** Outcome of a re-import attempt — `running` until it reaches a terminal value. */
export type ReimportResult = "running" | "success" | "error" | "no-newer-dataset";

/** The persisted re-import record. `date` is the once-per-day guard key. */
export interface ReimportRecord {
  /** Calendar day (local `YYYY-MM-DD`) the re-import was attempted. */
  date: string;
  /** Provider's newest dataset date (`YYYY-MM-DD`) at check time; null if undetermined. */
  latestDate: string | null;
  /** `running` while in flight, otherwise the terminal outcome. */
  result: ReimportResult;
  /** The OSM data date (`YYYY-MM-DD`) the app serves (updated on success). */
  dataDate: string;
  /** Human-readable detail (typically the error message). */
  message?: string;
  /** Epoch ms the attempt started. */
  startedAt?: number;
  /** Epoch ms the attempt reached its terminal result. */
  finishedAt?: number;
}

/** Suffix of the staging MBTiles a re-import builds before the atomic swap. */
const STAGING_SUFFIX = ".staging.mbtiles";

/**
 * Reads the persisted record from `file`, or null when it is absent or not
 * valid JSON. The file is written only by this app (atomically), so a present,
 * parseable file is trusted as a `ReimportRecord` — we only guard against a
 * missing/truncated file so a bad state reads as "no record" (a fresh attempt
 * is then allowed) instead of crashing the app.
 */
export function readLastReimport(file: string): ReimportRecord | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as ReimportRecord;
  } catch {
    return null;
  }
}

/**
 * Persists the record atomically: write to a temp file in the same directory,
 * then rename over `file` — so a crash mid-write can never leave a half-written
 * state file. Creates the parent directory if needed.
 */
export function writeLastReimport(file: string, record: ReimportRecord): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

/**
 * The once-per-day guard: true when a re-import was already attempted on
 * `today` (local `YYYY-MM-DD`). Checked BEFORE contacting the data server, so a
 * repeat trigger the same day never reaches the provider.
 */
export function alreadyAttemptedToday(file: string, today: string): boolean {
  return readLastReimport(file)?.date === today;
}

/**
 * Removes leftover `*.staging.mbtiles` files in `dataDir` (a crashed or
 * interrupted re-import). Only that suffix is removed — the live tilesets
 * (`openmaptiles.mbtiles`, `mtb.mbtiles`) and `dem.mbtiles` are untouched.
 * Returns the names removed. Best-effort: a missing/unreadable dir or a failed
 * unlink is logged, not thrown — this runs at boot and must not take the app
 * down.
 */
export function cleanStaging(dataDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch (e) {
    if (isErrno(e, "ENOENT")) return [];
    log(`cleanStaging: could not read ${dataDir}: ${errMsg(e)}`);
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(STAGING_SUFFIX)) continue;
    const full = path.join(dataDir, entry);
    try {
      unlinkSync(full);
      removed.push(entry);
      log(`cleanStaging: removed leftover ${entry}`);
    } catch (e) {
      log(`cleanStaging: failed to remove ${entry}: ${errMsg(e)}`);
    }
  }
  return removed;
}

function isErrno(e: unknown, code: string): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === code;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
