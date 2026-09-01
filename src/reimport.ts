import { renameSync } from "node:fs";
import { stagingPath, type Config } from "./config.js";
import type { BuildProgressFn, BuildTilesetsResult } from "./pipeline.js";
import {
  alreadyAttemptedToday,
  cleanStaging,
  readLastReimport,
  writeLastReimport,
  type ReimportRecord,
  type ReimportResult,
} from "./reimport-state.js";
import { isNewer } from "./upstream.js";
import { errorLog, log } from "./log.js";
import { status } from "./status.js";
import { readOsmDataDate } from "./osm-date.js";

export interface ReimportDeps {
  cfg: Config;
  lastReimportFile: string;
  currentDataDate: string | null;
  getLatestDatasetDate: () => Promise<string | null>;
  buildTilesets: (cfg: Config, hooks: BuildProgressFn) => Promise<BuildTilesetsResult>;
  martin: { restart(): Promise<void> };
}

export type ReimportRejectError = "already-running" | "already-attempted-today" | "no-newer-dataset";

export type ReimportDecision =
  | { kind: "started"; latestDate: string }
  | { kind: "rejected"; error: ReimportRejectError }
  | { kind: "upstream-error" };

export interface ReimportTriggerResult {
  decision: ReimportDecision;
  /** The background job, present when `decision.kind === "started"`. */
  job?: Promise<void>;
}

export type ReimportStatusState = ReimportResult | "idle";

export interface ReimportStatus {
  state: ReimportStatusState;
  date?: string;
  startedAt?: number;
  dataDate?: string;
  latestDate?: string;
  error?: string;
}

let inFlight = false;
let startedAt: number | null = null;

function setInFlight(value: boolean): void {
  inFlight = value;
  startedAt = value ? Date.now() : null;
}

export function resetReimportForTests(): void {
  setInFlight(false);
}

export function setInFlightForTests(value: boolean): void {
  setInFlight(value);
}

function today(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function triggerReimport(deps: ReimportDeps): Promise<ReimportTriggerResult> {
  const todayStr = today();
  log(`reimport: trigger requested (current data date: ${deps.currentDataDate ?? "unknown"})`);
  if (inFlight) {
    log("reimport: rejected — already running");
    return { decision: { kind: "rejected", error: "already-running" } };
  }

  setInFlight(true);
  let keepInFlight = false;
  try {
    if (alreadyAttemptedToday(deps.lastReimportFile, todayStr)) {
      log(`reimport: rejected — already attempted today (${todayStr})`);
      return { decision: { kind: "rejected", error: "already-attempted-today" } };
    }

    const startedAtMs = Date.now();
    writeLastReimport(deps.lastReimportFile, {
      date: todayStr,
      latestDate: null,
      result: "running",
      dataDate: deps.currentDataDate ?? "",
      startedAt: startedAtMs,
    });
    log("reimport: marked as running in the state file");

    log("reimport: checking the provider for a newer dataset");
    let latest: string | null;
    try {
      latest = await deps.getLatestDatasetDate();
    } catch (e) {
      const message = `cannot determine latest dataset: ${errMsg(e)}`;
      errorLog(`reimport: FAILED before download — ${message}`);
      writeLastReimport(deps.lastReimportFile, {
        date: todayStr,
        latestDate: null,
        result: "error",
        dataDate: deps.currentDataDate ?? "",
        message,
        startedAt: startedAtMs,
        finishedAt: Date.now(),
      });
      return { decision: { kind: "upstream-error" } };
    }

    if (latest === null || !isNewer(latest, deps.currentDataDate)) {
      log(
        `reimport: no newer dataset available ` +
          `(latest: ${latest ?? "unknown"}, current: ${deps.currentDataDate ?? "unknown"})`,
      );
      writeLastReimport(deps.lastReimportFile, {
        date: todayStr,
        latestDate: latest,
        result: "no-newer-dataset",
        dataDate: deps.currentDataDate ?? "",
        startedAt: startedAtMs,
        finishedAt: Date.now(),
      });
      return { decision: { kind: "rejected", error: "no-newer-dataset" } };
    }

    const latestDate: string = latest;
    writeLastReimport(deps.lastReimportFile, {
      date: todayStr,
      latestDate: latestDate,
      result: "running",
      dataDate: deps.currentDataDate ?? "",
      startedAt: startedAtMs,
    });
    log(`reimport: newer dataset found (${latestDate}) — starting the background build`);

    keepInFlight = true;
    const job = runReimportBuild(deps, latestDate);
    return { decision: { kind: "started", latestDate }, job };
  } finally {
    if (!keepInFlight) setInFlight(false);
  }
}

export async function runReimportBuild(deps: ReimportDeps, latestDate?: string): Promise<void> {
  const todayStr = today();
  const existing = readLastReimport(deps.lastReimportFile);
  const base: ReimportRecord = {
    date: existing?.date ?? todayStr,
    latestDate: latestDate ?? existing?.latestDate ?? null,
    result: existing?.result ?? "running",
    dataDate: existing?.dataDate ?? deps.currentDataDate ?? "",
    message: existing?.message,
    startedAt: existing?.startedAt,
    finishedAt: existing?.finishedAt,
  };

  log(`reimport: build started (target dataset: ${latestDate ?? existing?.latestDate ?? "unknown"})`);
  try {
    log("reimport: cleaning any stale staging artifacts");
    cleanStaging(deps.cfg.dataDir);
    const basemapStaging = stagingPath(deps.cfg.mbtilesFile);
    const mtbStaging = stagingPath(deps.cfg.mtbMbtilesFile);
    const stagingCfg: Config = {
      ...deps.cfg,
      mbtilesFile: basemapStaging,
      mtbMbtilesFile: mtbStaging,
      forceReimport: true,
    };

    log("reimport: building + verifying the staging tilesets");
    const buildResult = await deps.buildTilesets(stagingCfg, (u) => {
      if (u.message) log(u.message);
    });
    log("reimport: staging tilesets built and verified");

    // The data-date fallback (PBF mtime) must point at the extract the tileset
    // was actually built from — the downloaded file, not the mounted seed.
    const osmInput = buildResult.osmInput ?? deps.cfg.osmFile;
    const newDataDate = readOsmDataDate(basemapStaging, osmInput) ?? "";
    log("reimport: swapping the staging tilesets into place");
    renameSync(basemapStaging, deps.cfg.mbtilesFile);
    renameSync(mtbStaging, deps.cfg.mtbMbtilesFile);

    log("reimport: restarting Martin so it opens the new tilesets");
    await deps.martin.restart();
    log("reimport: Martin restarted");

    status.update({ dataDate: newDataDate || null, message: "Re-import complete" });
    writeLastReimport(deps.lastReimportFile, {
      ...base,
      result: "success",
      dataDate: newDataDate,
      message: undefined,
      finishedAt: Date.now(),
    });
    log(`reimport: complete — new data date ${newDataDate || "unknown"}`);
  } catch (e) {
    const message = errMsg(e);
    const detail = e instanceof Error && e.stack ? e.stack : message;
    errorLog(`reimport: FAILED — ${detail}`);
    log("reimport: cleaning staging artifacts after the failure");
    cleanStaging(deps.cfg.dataDir);
    const failed = readLastReimport(deps.lastReimportFile);
    writeLastReimport(deps.lastReimportFile, {
      date: failed?.date ?? base.date,
      latestDate: failed?.latestDate ?? base.latestDate,
      result: "error",
      dataDate: failed?.dataDate ?? base.dataDate,
      message,
      startedAt: failed?.startedAt ?? base.startedAt,
      finishedAt: Date.now(),
    });
    log("reimport: recorded the failed attempt in the state file");
  } finally {
    setInFlight(false);
  }
}

/**
 * Boot-time cleanup: remove leftover staging MBTiles and reconcile a record
 * stuck at `running` (the process died mid re-import) to `error`. The day
 * stays consumed — reset by deleting the state file.
 */
export function reconcileReimportOnBoot(dataDir: string, stateFile: string): void {
  cleanStaging(dataDir);
  const record = readLastReimport(stateFile);
  if (!record || record.date !== today() || record.result !== "running") return;
  writeLastReimport(stateFile, {
    ...record,
    result: "error",
    message: "interrupted by server restart",
    finishedAt: Date.now(),
  });
  log("reconciled a crashed re-import record as error");
}

export function reimportState(deps: Pick<ReimportDeps, "lastReimportFile">): ReimportStatus {
  const todayStr = today();
  if (inFlight) {
    return { state: "running", date: todayStr, startedAt: startedAt ?? undefined };
  }

  const record = readLastReimport(deps.lastReimportFile);
  if (!record || record.date !== todayStr) return { state: "idle" };

  const base = {
    date: record.date,
    startedAt: record.startedAt,
    dataDate: record.dataDate,
    latestDate: record.latestDate ?? undefined,
    error: record.message,
  };

  switch (record.result) {
    case "running":
      return { state: "error", ...base };
    case "success":
      return { state: "success", ...base };
    case "no-newer-dataset":
      return { state: "no-newer-dataset", ...base };
    case "error":
      return { state: "error", ...base };
    default:
      throw new Error(`unknown re-import result: ${String(record.result)}`);
  }
}
