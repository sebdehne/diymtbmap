# Plan — Web-triggered OSM re-import (re-run the pipeline)

**Status:** COMPLETE — Steps 1–8 done ✅; Step 9 skipped ⏭️; Step 10 done ✅.

## Goal
Let the web UI trigger a re-download + re-build of the OSM **vector** tiles (basemap `openmaptiles.mbtiles` + MTB overlay `mtb.mbtiles`) when a newer Geofabrik dataset exists — while **keeping the current map serving** and swapping to the new data **only on success**. The elevation tileset (`dem.mbtiles`) is never touched (it is mounted in, not built by this app).

## Finalized decisions
| Decision | Choice |
|---|---|
| Gating | **Always available** (no toggle/token). Server-side bounded by the two guards below. |
| Anti-spam | The app **remembers that it attempted** a re-import (not just a success) — at most **one data-server contact cycle per calendar day**. |
| Concurrency | **In-process** `inFlight` flag (single-container design). |
| Trigger model | **`POST /api/reimport`** — a single call that kicks off the re-import **in the background** and returns immediately (`202`, or a `409`/`502` rejection). **Not long-lived.** |
| Status model | **`GET /api/reimport`** — coarse state: `idle` / `running` / `success` / `error` / `no-newer-dataset`. The info page reads this to display the current status. |
| UI | Button → "Reimport running, it might take a while" (grayed) while `running` → on `success`: brief "Done" + `location.reload()` (new map + new date, button grayed); on `error`: "Reimport failed — contact admin." (grayed); `no-newer-dataset`: "Data is already up to date." (grayed). Grayed for the rest of the day either way. |
| "Newer?" check | Parse newest `norway-YYYYMMDD.osm.pbf` from the `.html` listing; compare to current `dataDate`; strictly newer → proceed. |
| Source URL | `OSM_LISTING_URL` is the provider listing page; the concrete dated `.osm.pbf` download URL is resolved from it. The old `OSM_URL` env/config knob is gone. |
| Keep map up | Build to **staging** MBTiles, verify, then atomic `rename` over live files + **restart Martin** (which holds the old files open → no interruption). |

## Gating (server-side, enforced even on direct API calls)
1. **Single in-flight** — in-process `inFlight` flag. A second concurrent trigger gets `409 already-running`.
2. **Once per day on *attempts*** — `last-reimport.json` (in `/data`) records the calendar day a re-import was *attempted*. A trigger on an already-attempted day gets `409 already-attempted-today` **without contacting the data server**. This bounds Geofabrik traffic (the light listing fetch AND the ~1.4 GB download) to one cycle/day, so repeated clicks can't spam the data server or burn the day's build.

> Reset: delete `<DATA_DIR>/last-reimport.json` to allow another attempt the same day (e.g. after a transient failure, or to force a check).

## API contract
- **`POST /api/reimport`** (single call; kicks off the background job)
  - `202 { started:true, latestDate:"YYYY-MM-DD" }` — a re-import is now running
  - `409 { error:"already-running" | "already-attempted-today" | "no-newer-dataset" }`
  - `502 { error:"cannot-determine-latest" }`
- **`GET /api/reimport`** (status the info page displays)
  - `{ state:"idle" }` — nothing attempted today (button enabled)
  - `{ state:"running", date, startedAt }` — in flight (button grayed, "might take a while")
  - `{ state:"success", date, dataDate }` — completed (button grayed)
  - `{ state:"error", date, error? }` — failed (button grayed, "contact admin")
  - `{ state:"no-newer-dataset", date }` — checked, nothing newer (button grayed, "up to date")
- `GET /api/status` (existing, unchanged) — top-level `state` stays `"ready"` throughout, so the map never unmounts. (The re-import status lives on its own endpoint, not here.)

## Trigger flow — `POST /api/reimport`
POST handler runs the fast guards + upstream check (bounded to once/day), then starts the background job:
1. If `inFlight` → `409 {error:"already-running"}`.
2. `inFlight = true`.
3. If `alreadyAttemptedToday(lastReimportFile)` → `409 {error:"already-attempted-today"}`, `inFlight=false`, return. (**No data-server contact.**)
4. **Record the attempt** (write `last-reimport.json` with today's date, `result:"running"`). ← the anti-spam commit point.
5. Upstream check `getLatestDatasetDate(osmListingUrl)`:
   - unreachable → record `result:"error"`; `inFlight=false`; `502 {error:"cannot-determine-latest"}`.
   - not strictly newer than current `dataDate` → record `result:"no-newer-dataset"`; `inFlight=false`; `409 {error:"no-newer-dataset"}`.
6. **Start the background job** (`void runReimportBuild(...)`), return `202 {started:true, latestDate}`.

**Background job** (`runReimportBuild`, same process, updates status + record as it goes):
- download new PBF → `OSM_DOWNLOAD_FILE` (writable; higher priority than the mounted seed `OSM_FILE`, which is never touched; the PBF is never served)
- build basemap → `<name>.staging.mbtiles`; build MTB → `<name>.staging.mbtiles`
- verify both staging artifacts (existing `verify.ts`)
- **swap**: `rename` each staging file over its live path (atomic, same fs)
- **restart Martin** so it opens the new files (old files stay served until then)
- update `status.dataDate`; record `result:"success"` + new `dataDate` (or `result:"error"` on any failure — remove staging, old tileset + map untouched)
- finally: `inFlight = false`

## `GET /api/reimport` derivation
- If `inFlight` → `{ state:"running", date: today, startedAt }`.
- Else read `last-reimport.json`: if `date === today` → map `result` (`success`→success, `no-newer-dataset`→no-newer-dataset, `error`/`pending`→error) → `{ state, date, dataDate?, error? }`.
- Else → `{ state:"idle" }`.

## Files to add / change
- **new** `src/upstream.ts` — `parseLatestDate(html)`, `getLatestDatasetDate(url)`, `isNewer(latest, current)`
- **new** `src/reimport-state.ts` — `readLastReimport` / `writeLastReimport` / `alreadyAttemptedToday` / `cleanStaging`
- **new** `src/reimport.ts` — in-memory `inFlight` + `startedAt`; `triggerReimport(deps)` (guards + upstream check + kick off background) and `runReimportBuild(deps)` (build/swap/restart); `reimportState()` for `GET /api/reimport`
- `src/pipeline.ts` — extract `buildTilesets(cfg, hooks)` core (behavior-preserving); `runPipeline` = core + start Martin + ready
- `src/status.ts` — **no change** (re-import status is separate; top-level stays `ready`)
- `src/martin.ts` — add `MartinServer.restart()`
- `src/server.ts` — `POST /api/reimport` + `GET /api/reimport`; on startup, `cleanStaging(dataDir)` + reconcile a crashed `result:"running"` → `"error"`
- `src/config.ts` + `.env.example` — `osmListingUrl` (default `https://download.geofabrik.de/europe/norway.html`), `reimportStateFile` (`<DATA_DIR>/last-reimport.json`), staging-path helpers
- `web/src/components/InfoPanel.jsx` (+ `web/src/styles.css`) — re-import button + states; polls `GET /api/reimport` only while `running`; on `success` → `location.reload()`. **`web/src/App.jsx` is unchanged.**
- **tests** `test/upstream.test.ts`, `test/reimport-state.test.ts`, `test/pipeline-plan.test.ts`, `test/reimport.test.ts`, `test/config.test.ts`, `test/server.test.ts`; extend `test/martin.test.ts`
- **docs** `DESIGN.md`, `README.md` — describe the feature + `OSM_LISTING_URL`

## Work breakdown (each step independently testable)
Order matters (later steps depend on earlier ones). "Verify" is the command to run after that step.

### Step 1 — Upstream date parsing ✅ DONE
`src/upstream.ts`: pure `parseLatestDate(html) → "YYYY-MM-DD" | null` (newest `norway-YYYYMMDD.osm.pbf`); `isNewer(latest, current)` (null current ⇒ true); `getLatestDatasetDate(url)` (fetch + timeout, throw on non-200).
- Test `test/upstream.test.ts`: `parseLatestDate` on sample Geofabrik HTML (multi-date, no dates, malformed), `isNewer` cases; `getLatestDatasetDate` against a tiny local HTTP server.
- Verify: `npm run typecheck && npx tsx --test test/upstream.test.ts`
- **Result (2026-09-01):** implemented + 13 tests passing; typecheck, lint clean. `getLatestDatasetDate` fetch timeout set to **15 min** (deliberately generous); the large PBF download (`src/download.ts`) keeps no absolute timeout by design (streams + resume + retries).

### Step 2 — Attempt/success record + staging cleanup ✅ DONE
`src/reimport-state.ts`: `readLastReimport` / `writeLastReimport` / `alreadyAttemptedToday(file, today)` / `cleanStaging(dataDir)` (remove only `*.staging.mbtiles`).
- Test `test/reimport-state.test.ts`: write/read round-trip, missing file, already-today true/false, `cleanStaging` removes staging only (leaves live + dem files).
- Verify: `npm run typecheck && npx tsx --test test/reimport-state.test.ts`
- **Result (2026-09-01):** implemented + 10 tests passing; typecheck, lint, full `npm test` (211) green. Record fields: `date` (guard key), `latestDate`, `result` (`running`/`success`/`error`/`no-newer-dataset`), `dataDate`, `message?`, `startedAt?`, `finishedAt?`. Write is atomic (temp + rename). `cleanStaging` is best-effort (missing dir / failed unlink logged, not thrown) so boot can't be taken down. `readLastReimport` trusts the app-written shape (only guards missing/unparseable → null; no `toRecord` validation). **Both new test files added to the `npm test` file list** so the canonical suite covers them.

### Step 3 — Extract `buildTilesets(cfg, hooks)` from `runPipeline` ✅ DONE
`src/pipeline.ts`: pull the download→build→verify sequence into `buildTilesets(cfg, hooks)` where `hooks` is a progress callback; extract the pure "plan" decision (skip/build basemap, skip/build mtb) into `planBuilds(cfg, artifactPresent)`. `runPipeline` keeps identical behavior + starts Martin + ready.
- Test `test/pipeline-plan.test.ts`: `planBuilds` across cfg states (artifact present/absent, force, stale mtb minzoom). Existing `test/` still green.
- Verify: `npm run typecheck && npm run lint && npm test`
- **Result (2026-09-01):** implemented + 6 `planBuilds` tests passing; typecheck, lint, and full `npm test` (217; 216 pass, 1 skipped) green. `buildTilesets(cfg, hooks)` owns the shared download → build → verify flow for `openmaptiles.mbtiles` + `mtb.mbtiles`, reports progress via `hooks`, and does not start Martin or flip the app to `ready`. `runPipeline` calls it, then starts Martin + serving verification + `ready`. `planBuilds` fails fast on a stale/missing `mtb_minzoom`. Existing startup behavior was preserved, including the original MTB-branch `checkToolchain` condition.

### Step 4 — `MartinServer.restart()` ✅ DONE
`src/martin.ts`: `restart()` — suppress the watchdog, kill current proc, wait for exit, re-arm, `start()` fresh.
- Test: extend `test/martin.test.ts` with a stub `martin` binary (serves `/health` + `/catalog`): start → restart → still serving; no double-start on intentional exit.
- Verify: `npm run typecheck && npx tsx --test test/martin.test.ts`
- **Result (2026-09-01):** implemented + `test/martin.test.ts` now 19 passing; typecheck, lint, and full `npm test` (218; 217 pass, 1 skipped) green. `MartinServer.restart()` suppresses the watchdog, waits for the old process to exit (SIGTERM, then SIGKILL after 10s), and starts a fresh Martin. `start()` is now concurrency-safe via a `startPromise` guard, so an intentional stop cannot race a watchdog restart.

### Step 5 — Re-import orchestration (background) ✅ DONE
`src/reimport.ts`: `inFlight`/`startedAt` state; `triggerReimport(deps)` (guard flow + upstream check + kick off background, returns a decision) and `runReimportBuild(deps)` (staging build → verify → swap → restart → status/record update); `reimportState()` (running / lastRun → API state). `deps` inject `getLatestDatasetDate`, `buildTilesets`, `martin`, and the state file so it is testable without a JVM.
- Test `test/reimport.test.ts` (stubs): concurrent → `already-running`; already-attempted → `already-attempted-today` (no upstream call); no-newer → `no-newer-dataset` (record written); unreachable → `cannot-determine-latest` (record written); success → record `success` + new `dataDate` + swap+restart called; `reimportState()` maps running/lastRun → `running`/`success`/`error`/`no-newer-dataset`/`idle`.
- Verify: `npm run typecheck && npx tsx --test test/reimport.test.ts`
- **Result (2026-09-01):** implemented + 7 tests passing; typecheck, lint, and full `npm test` (225; 224 pass, 1 skipped) green. `triggerReimport(deps)` enforces `inFlight` + once-per-day guards, records the attempt, checks upstream, and starts the background job. `runReimportBuild(deps, latestDate)` builds to `*.staging.mbtiles`, swaps over the live MBTiles, restarts Martin, updates the status data date, and records `success`/`error`. `reimportState(deps)` maps the in-memory + persisted state to the API state.

### Step 6 — API routes — done ✅
`src/server.ts`: `POST /api/reimport` (wires `triggerReimport`, returns `202`/`409`/`502`) + `GET /api/reimport` (returns `reimportState()`). On boot, `cleanStaging(cfg.dataDir)` + reconcile a crashed `result:"running"` → `"error"`.
- Test `test/server.test.ts`: mount the inner app with a stubbed re-import; assert `202`/`409`/`502` + `GET /api/reimport` states + body shapes.
- Verify: `npm run typecheck && npx tsx --test test/server.test.ts`
- **Result:** added `src/reimport-api.ts`, `reconcileReimportOnBoot`, server wiring, and `test/server.test.ts`; `npm run typecheck`, `npm run lint`, and full `npm test` green (235 tests, 234 passed, 1 skipped).

### Step 7 — Config — done ✅
`src/config.ts` + `.env.example`: `osmListingUrl`, `reimportStateFile`, `stagingPath`.
- Test `test/config.test.ts`: defaults + env override.
- Verify: `npm run typecheck && npx tsx --test test/config.test.ts`
- **Result:** config fields + `stagingPath` exported and used by re-import/server; `npm run typecheck`, `npm run lint`, and full `npm test` green (238 tests, 237 passed, 1 skipped).

### Step 8 — Info panel re-import UI (status-driven) — done ✅
`web/src/components/InfoPanel.jsx` + `web/src/styles.css`: an "Update data" button near the existing data-date line. On mount, `GET /api/reimport` sets the initial state. On click: `POST /api/reimport` → `202` → grayed + "Reimport running, it might take a while" + start polling `GET /api/reimport` (a few seconds) while `running`; `success` → brief "Done" + `location.reload()`; `error` → "Reimport failed — contact admin."; `409 no-newer-dataset` → "Data is already up to date." Button stays grayed for the day.
- Verify: `npm run build:web` (vite typecheck) + manual (trigger against a `SKIP_PIPELINE` dev server / local stub).
- **Result:** added the status-driven Update-data button + polling to `InfoPanel.jsx` and styles; `npm run lint`, `npm run build:web`, and full `npm test` green (243 tests, 242 passed, 1 skipped).

### Step 9 — End-to-end (optional, heavy — needs JVM + a fixture) — skipped ⏭️
`scripts/e2e-reimport.ts`: start the app with a local fake Geofabrik (a "newer" listing + a tiny valid PBF) and a real or stubbed build; `POST` the trigger, poll `GET /api/reimport`; assert swap + Martin restart + new `dataDate` + map still serving old data until the swap.
- Verify: `npx tsx scripts/e2e-reimport.ts`
- **Result:** skipped by request; unit/integration coverage plus manual verification is sufficient for now.

### Step 10 — Docs — done ✅
`DESIGN.md` (new "Re-import (on demand)" section), `README.md` (usage + `OSM_LISTING_URL` + reset), `.env.example` (new var).
- Verify: read-through; `npm run lint`
- **Result:** documented the on-demand re-import flow/API/reset in `DESIGN.md`, added the `REIMPORT_STATE_FILE` config row and Update-data usage to `README.md`, and kept `.env.example` in sync; `npm run lint` green.

## Edge cases / failure handling
- **Build fails** → staging removed, old tileset + map intact, `last-reimport.json` records `error` (day consumed — reset by deleting the file). Status: `error`. UI: "Reimport failed — contact admin."
- **Geofabrik unreachable** → `502`, day consumed (recorded) to stop repeated probing; reset by deleting the file. Status: `error`.
- **No newer dataset** → `409 no-newer-dataset`, day consumed (we did fetch the listing). Status: `no-newer-dataset`. UI: "Data is already up to date."
- **Crash mid-build / process restart** → `inFlight` resets; a record stuck at `result:"running"` is reconciled to `error` on boot; `cleanStaging` removes leftover `*.staging.mbtiles`; the day stays consumed.
- **Client closes the tab** → the background job keeps running server-side; `GET /api/reimport` still reflects `running`→terminal; data updates regardless (the day is already consumed, so it won't re-trigger).
- **Disk headroom** → staging needs room for a full extra copy of both MBTiles; an `ENOSPC` is a build failure (old data intact). Surface a clear message.
- **Clock** → "today" uses the container's local date consistently; NTP drift could permit a second build near midnight (acceptable).

## Full verification (after all steps)
`npm run typecheck && npm run lint && npm test && npm run build:web`
