import {
  createWriteStream,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { log } from "./log.js";

export type ProgressFn = (bytes: number, total: number | null) => void;

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;
const REPORT_INTERVAL_MS = 250;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Remove a finished extract and its partial file (used by FORCE_REIMPORT). */
export function clearArtifact(file: string): void {
  for (const p of [file, `${file}.part`]) {
    if (existsSync(p)) unlinkSync(p);
  }
}

/**
 * Stream `url` into `dest`, writing to `dest.part` first and renaming on
 * success. Interrupted downloads are resumed via Range requests; progress is
 * reported through `onProgress` (throttled to ~4x/s).
 */
export async function download(
  url: string,
  dest: string,
  onProgress: ProgressFn,
): Promise<void> {
  const part = `${dest}.part`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await attemptOnce(url, part, dest, onProgress);
      return;
    } catch (e) {
      lastError = e;
      log(
        `download attempt ${attempt}/${MAX_ATTEMPTS} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `download failed after ${MAX_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function attemptOnce(
  url: string,
  part: string,
  dest: string,
  onProgress: ProgressFn,
): Promise<void> {
  let resumeFrom = existsSync(part) ? statSync(part).size : 0;
  const headers: Record<string, string> = { "user-agent": "diymtbmap (node)" };
  if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`;

  const res = await fetch(url, { headers, redirect: "follow" });

  if (res.status === 416) {
    log("server reports range not satisfiable — treating partial file as complete");
    renameSync(part, dest);
    onProgress(resumeFrom, resumeFrom);
    return;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  if (res.status === 200 && resumeFrom > 0) {
    log("server ignored Range header — starting download from scratch");
    resumeFrom = 0;
  }
  if (res.body === null) throw new Error("empty response body");

  const lengthHeader = res.headers.get("content-length");
  const total = lengthHeader !== null ? resumeFrom + Number(lengthHeader) : null;

  const body = Readable.fromWeb(res.body);
  let received = resumeFrom;
  let lastReport = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding: unknown, callback: (e?: Error | null, c?: Buffer) => void) {
      received += chunk.length;
      const now = Date.now();
      if (now - lastReport >= REPORT_INTERVAL_MS) {
        lastReport = now;
        onProgress(received, total);
      }
      callback(null, chunk);
    },
  });

  const out = createWriteStream(part, { flags: resumeFrom > 0 ? "a" : "w" });
  await pipeline(body, counter, out);
  onProgress(received, total);
  renameSync(part, dest);
  log(`download complete: ${dest} (${received} bytes)`);
}
