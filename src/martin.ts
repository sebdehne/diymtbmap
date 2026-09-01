import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { OPTIONAL_LAYERS, REQUIRED_LAYERS, readDeclaredLayers } from "./verify.js";

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 500;
const RESTART_DELAY_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The basemap MBTiles source Martin serves. Martin derives the source ID
 * from the MBTiles file name (openmaptiles.mbtiles -> "openmaptiles"), and
 * the basemap style references it by that ID.
 */
export const EXPECTED_SOURCE = "openmaptiles";

/**
 * The MTB overlay source ID (step 11): Martin derives it from the MTB
 * MBTiles file name (mtb.mbtiles -> "mtb"), so it follows the configured
 * MTB_MBTILES_FILE. The overlay + served style reference it by that ID.
 */
export function expectedMtbSource(mbtilesFile: string): string {
  const base = path.basename(mbtilesFile);
  return base.endsWith(".mbtiles") ? base.slice(0, -".mbtiles".length) : base;
}

/**
 * The optional 3D-terrain source ID: Martin derives it from the DEM MBTiles
 * file name (dem.mbtiles -> "dem"), so it follows the configured
 * DEM_MBTILES_FILE. The served style + terrain toggle reference it by that ID.
 */
export function expectedDemSource(mbtilesFile: string): string {
  const base = path.basename(mbtilesFile);
  return base.endsWith(".mbtiles") ? base.slice(0, -".mbtiles".length) : base;
}

/**
 * Shape of Martin's /catalog document (sources under `tiles`). Verified
 * against Martin 1.14.0 (source id = MBTiles file name; for MBTiles sources
 * the entry carries content_type/content_encoding/name/description/
 * attribution — but NO vector layer list, which is why the layer check is
 * done against the served MBTiles file itself, see assertExpectedLayers).
 */
export interface MartinCatalog {
  tiles?: Record<string, { content_type?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * Extracts the `mbtiles:` file list from a (simple, app-owned) Martin YAML
 * config. Ignores everything else — martin.yaml is written by this app, so
 * no general YAML parsing is needed.
 */
export function parseMbtilesPaths(yamlText: string): string[] {
  const paths: string[] = [];
  let inMbtiles = false;
  for (const line of yamlText.split("\n")) {
    const t = line.trim();
    if (/^mbtiles\s*:/.test(t)) {
      inMbtiles = true;
      continue;
    }
    if (inMbtiles) {
      const m = t.match(/^-\s*('?)([^'\s]+)\1?/);
      if (m?.[2] !== undefined) paths.push(m[2]);
      else if (t !== "" && !t.startsWith("#")) inMbtiles = false;
    }
  }
  return paths;
}

/** The source IDs Martin serves (keys of /catalog's `tiles`). */
export function sourceIds(catalog: MartinCatalog): string[] {
  return Object.keys(catalog.tiles ?? {}).sort();
}

/**
 * The basemap style and the MTB overlay reference their sources by ID and as
 * MVT sources, so a missing source (or the wrong content type) means a broken
 * map — fail the pipeline instead of serving a half-working tile server.
 * `mtbSource` (optional) is the step-11 MTB overlay source to require as
 * well.
 */
export function assertExpectedCatalog(catalog: MartinCatalog, mtbSource?: string): void {
  const expected = mtbSource === undefined ? [EXPECTED_SOURCE] : [EXPECTED_SOURCE, mtbSource];
  const ids = sourceIds(catalog);
  const missing = expected.filter((s) => !ids.includes(s));
  if (missing.length > 0) {
    throw new Error(
      `martin is not serving the expected tile source(s) ${missing
        .map((s) => `"${s}"`)
        .join(" + ")} (serving: ${ids.join(", ") || "none"})`,
    );
  }
  for (const s of expected) {
    const contentType = catalog.tiles?.[s]?.content_type;
    if (contentType !== "application/x-protobuf") {
      throw new Error(
        `martin's "${s}" source has content_type "${contentType ?? "(missing)"}" (expected "application/x-protobuf" — the style needs MVT)`,
      );
    }
  }
  const extra = ids.filter((s) => !expected.includes(s));
  if (extra.length > 0) {
    log(`note: martin also serves: ${extra.join(", ")}`);
  }
}

/**
 * The basemap style needs the 15 required OMT layers; a missing one means a
 * broken map, so fail the pipeline. A missing optional layer (aerodrome_
 * label) only degrades to an empty render — warn, don't fail. (Same rules as
 * the tileset artifact verification in verify.ts.)
 */
export function assertExpectedLayers(layers: readonly string[]): void {
  const missingRequired = REQUIRED_LAYERS.filter((l) => !layers.includes(l));
  if (missingRequired.length > 0) {
    throw new Error(
      `tileset is missing required layers: ${missingRequired.join(", ")} (found: ${[...layers].sort().join(", ")})`,
    );
  }
  const missingOptional = OPTIONAL_LAYERS.filter((l) => !layers.includes(l));
  if (missingOptional.length > 0) {
    log(
      `warning: tileset is missing optional layer(s) ${missingOptional.join(", ")} — the style renders them empty`,
    );
  }
}

/**
 * Spawns Martin, waits until it answers on /health, and keeps it alive:
 * if the process dies later it is restarted automatically.
 */
export class MartinServer {
  readonly url: string;
  sources: string[] = [];
  /** MVT layers of the MBTiles Martin serves (verified at startup). */
  layers: string[] = [];
  private cfg: Config;
  private proc: ChildProcess | null = null;
  private shuttingDown = false;
  private startPromise: Promise<void> | null = null;

  constructor(cfg: Config) {
    this.cfg = cfg;
    const host =
      cfg.martinBind === "0.0.0.0" || cfg.martinBind === "::" || cfg.martinBind === "::1"
        ? "127.0.0.1"
        : cfg.martinBind;
    this.url = `http://${host}:${cfg.martinPort}`;
    // Martin must never outlive this process: an orphaned instance keeps
    // holding its port and silently serves whatever tileset it was started
    // with (e.g. an e2e fixture) to any client that resolves the host to it,
    // which is far harder to diagnose than the original crash. SIGKILL on
    // the parent cannot be caught, so this only covers crashes, Ctrl-C, and
    // SIGTERM — the realistic cases.
    const killChild = () => {
      if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
        this.proc.kill("SIGKILL");
      }
    };
    process.on("exit", killChild);
    process.on("SIGINT", () => {
      killChild();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      killChild();
      process.exit(143);
    });
  }

  /** Blocks until Martin is answering (retries indefinitely). */
  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    this.verifyConfig();
    for (;;) {
      const proc = this.spawnProc();
      if (await this.waitReady(proc)) {
        this.proc = proc;
        const catalog = await this.fetchCatalog();
        this.sources = sourceIds(catalog);
        assertExpectedCatalog(catalog, expectedMtbSource(this.cfg.mtbMbtilesFile));
        this.watch(proc);
        log(
          `martin ready at ${this.url} (source: ${EXPECTED_SOURCE}, layers: ${this.layers.join(", ")})`,
        );
        return;
      }
      log("martin did not become ready — retrying in 5s");
      await sleep(RESTART_DELAY_MS);
    }
  }

  /**
   * Stop the current Martin and start a fresh one (used after an on-demand
   * re-import has swapped the MBTiles files). The watchdog is suppressed for
   * the intentional stop so it does not race the fresh start.
   */
  async restart(): Promise<void> {
    if (this.startPromise) await this.startPromise;
    const proc = this.proc;
    if (proc !== null) {
      this.shuttingDown = true;
      const exited = this.waitForExit(proc, 10_000);
      proc.kill("SIGTERM");
      await exited;
      this.proc = null;
      this.shuttingDown = false;
    }
    log("restarting martin");
    await this.start();
  }

  private waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
    if (proc.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
      }, timeoutMs);
      timer.unref();
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Fail fast when martin.yaml and the app disagree about the MBTiles file —
   * otherwise Martin would start fine but serve nothing (or the wrong file),
   * which is hard to diagnose.
   */
  private verifyConfig(): void {
    const path = this.cfg.martinConfig;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new Error(
        `cannot read martin config ${path}: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
    const paths = parseMbtilesPaths(text);
    if (paths.length === 0) {
      throw new Error(`martin config ${path} has no mbtiles sources`);
    }
    // Both tilesets must be listed (the basemap AND the step-11 mtb
    // overlay) and present on disk — otherwise Martin would start fine but
    // serve a broken map, which is hard to diagnose.
    for (const file of [this.cfg.mbtilesFile, this.cfg.mtbMbtilesFile]) {
      if (!paths.includes(file)) {
        throw new Error(
          `martin.yaml mbtiles (${paths.join(", ")}) does not include the app's tileset file ${file} — fix martin.yaml (or MBTILES_FILE / MTB_MBTILES_FILE)`,
        );
      }
      if (!existsSync(file)) {
        throw new Error(
          `tileset file ${file} not found — run the pipeline (or wait for it) before starting Martin`,
        );
      }
    }
    // The optional 3D-terrain tileset (dem.mbtiles) is NOT required: when it is
    // absent the whole feature degrades away (no `dem` source, no toggle) and
    // the rest of the map is unaffected. Martin's `on_invalid: warn` (set in
    // martin.yaml) lets it start fine with a missing listed file, so we must not
    // throw here. A present-but-unlisted file would silently disable the feature,
    // so that specific mismatch is warned about.
    const demPresent = existsSync(this.cfg.demMbtilesFile);
    if (demPresent) {
      if (paths.includes(this.cfg.demMbtilesFile)) {
        log(
          `optional terrain tileset present: ${this.cfg.demMbtilesFile} ` +
            `(served as "${expectedDemSource(this.cfg.demMbtilesFile)}")`,
        );
      } else {
        log(
          `warning: ${this.cfg.demMbtilesFile} exists but is not listed in martin.yaml mbtiles — ` +
            `the 3D terrain source will NOT be served (list it there, or fix DEM_MBTILES_FILE)`,
        );
      }
    } else {
      log(
        `no terrain tileset at ${this.cfg.demMbtilesFile} — 3D terrain feature is off ` +
          `(degraded; everything else unaffected)`,
      );
    }
    // Martin 1.14's /catalog does not list the vector layers of an MBTiles
    // source, so the layers of the very file Martin opens are the ground
    // truth for what the style will be served (metadata-only read).
    this.layers = readDeclaredLayers(this.cfg.mbtilesFile).sort();
    assertExpectedLayers(this.layers);
    log(
      `martin config OK — serving ${this.cfg.mbtilesFile} (${this.layers.length} layers) ` +
        `+ ${this.cfg.mtbMbtilesFile} (mtb overlay)`,
    );
  }

  /** Fetch the /catalog document Martin serves (sources under `tiles`). */
  private async fetchCatalog(): Promise< MartinCatalog> {
    const res = await fetch(`${this.url}/catalog`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`martin /catalog failed: HTTP ${res.status}`);
    return (await res.json()) as MartinCatalog;
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.proc?.kill("SIGTERM");
  }

  private spawnProc(): ChildProcess {
    const args = [
      "--config",
      this.cfg.martinConfig,
      "--listen-addresses",
      `${this.cfg.martinBind}:${this.cfg.martinPort}`,
    ];
    log(`starting: martin ${args.join(" ")}`);
    const proc = spawn("martin", args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout?.on("data", (d: Buffer) => this.drain("out", d));
    proc.stderr?.on("data", (d: Buffer) => this.drain("err", d));
    return proc;
  }

  private drain(stream: "out" | "err", d: Buffer): void {
    for (const line of d.toString("utf8").split("\n")) {
      if (line.trim() !== "") log(`martin[${stream}]: ${line.trim()}`);
    }
  }

  private watch(proc: ChildProcess): void {
    proc.on("exit", (code, signal) => {
      this.proc = null;
      if (this.shuttingDown) return;
      log(`martin exited (code=${code} signal=${signal}) — restarting in 5s`);
      setTimeout(() => {
        void this.start();
      }, RESTART_DELAY_MS).unref();
    });
  }

  private async waitReady(proc: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.killed) return false;
      try {
        const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) return true;
      } catch {
        // not up yet — keep polling
      }
      await sleep(READY_POLL_MS);
    }
    proc.kill("SIGKILL");
    return false;
  }
}
