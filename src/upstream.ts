/**
 * Upstream dataset discovery: determines the newest OSM extract the data
 * provider currently offers, so a re-import can tell whether a newer dataset
 * exists before spending a large download + build on it.
 *
 * The Geofabrik download page (e.g. https://download.geofabrik.de/europe/
 * norway.html) lists one file per extract as `<name>-<YYMMDD>.osm.pbf`. The
 * newest such date is the provider's current dataset; it is compared against
 * the date this app already has (see osm-date.ts).
 */

// Generous: this also guards the re-import's data-server contact, and a slow
// provider response should not fail the (once-a-day) check.
const FETCH_TIMEOUT_MS = 15 * 60_000;

/** A link to a dated extract, e.g. `norway-260831.osm.pbf`. */
const DATED_FILE_RE = /(\d{6})\.osm\.pbf/g;

/**
 * The newest extract date present in a provider listing page, as `YYYY-MM-DD`,
 * or null when no dated `.osm.pbf` file is found. Undated entries
 * (`norway-latest.osm.pbf`, `norway-freeform.osm.pbf`) are ignored.
 */
export function parseLatestDate(html: string): string | null {
  let best: string | null = null;
  for (const match of html.matchAll(DATED_FILE_RE)) {
    const iso = toIso(match[1] ?? "");
    if (iso !== null && (best === null || iso > best)) best = iso;
  }
  return best;
}

/** The newest dated extract in a listing page, resolved to a download URL. */
export interface LatestDataset {
  date: string;
  url: string;
}

/**
 * The newest dated `.osm.pbf` link in a provider listing page, resolved
 * against `baseUrl`, or null when no dated link is found. Undated entries
 * (`norway-latest.osm.pbf`, `norway-freeform.osm.pbf`) are ignored.
 */
export function parseLatestDataset(html: string, baseUrl: string): LatestDataset | null {
  let best: LatestDataset | null = null;
  for (const match of html.matchAll(/href="([^"]+\.osm\.pbf)"/g)) {
    const href = match[1] ?? "";
    const path = href.split(/[?#]/)[0] ?? "";
    const dateMatch = path.match(/(\d{6})\.osm\.pbf$/);
    if (dateMatch === null) continue;
    const date = toIso(dateMatch[1] ?? "");
    if (date === null) continue;
    let url: string;
    try {
      url = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    if (best === null || date > best.date) best = { date, url };
  }
  return best;
}

/**
 * Whether `latest` (the provider's current dataset) is strictly newer than
 * `current` (what this app already has). A null `latest` means we could not
 * determine the provider's date → treat as "no update". A null `current` means
 * we have no recorded date → treat as "an update is available" (safer to check
 * than to assume we are current). Dates compare lexicographically because they
 * are all `YYYY-MM-DD`.
 */
export function isNewer(latest: string | null, current: string | null): boolean {
  if (latest === null) return false;
  if (current === null) return true;
  return latest > current;
}

/**
 * Fetches a provider listing page and returns its newest extract date
 * (`YYYY-MM-DD`). Throws on a non-2xx response or a failed fetch (timeout /
 * unreachable), so callers can map that to a "cannot determine latest" error.
 * Returns null when the page fetches fine but carries no dated file.
 */
export async function getLatestDatasetDate(url: string): Promise<string | null> {
  const html = await fetchListing(url);
  return parseLatestDate(html);
}

/**
 * Fetches a provider listing page and returns the newest dated extract's
 * download URL (resolved against the listing URL). Throws on a non-2xx
 * response or a failed fetch. Returns null when the page fetches fine but
 * carries no dated `.osm.pbf` link.
 */
export async function getLatestDatasetUrl(url: string): Promise<string | null> {
  const html = await fetchListing(url);
  return parseLatestDataset(html, url)?.url ?? null;
}

async function fetchListing(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  }
  return res.text();
}

/**
 * Turns a Geofabrik `YYMMDD` date (e.g. `260831`) into `YYYY-MM-DD`
 * (`2026-08-31`), returning null when it is not a real calendar date so an
 * arbitrary 6-digit number in a page is never mistaken for an extract date.
 */
function toIso(yyyymmdd: string): string | null {
  if (!/^\d{6}$/.test(yyyymmdd)) return null;
  const year = 2000 + Number(yyyymmdd.slice(0, 2));
  const month = Number(yyyymmdd.slice(2, 4));
  const day = Number(yyyymmdd.slice(4, 6));
  if (month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day > daysInMonth) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
