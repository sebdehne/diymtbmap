import { existsSync, statSync } from "node:fs";
import Database from "better-sqlite3";

/**
 * The OSM "data as of" date (workstream A), "YYYY-MM-DD" or null.
 *
 * Primary source: the replication / create timestamp planetiler records in the
 * basemap MBTiles metadata (`planetiler:osm:osmosisreplicationtime`) — for a
 * real Geofabrik extract this is the extract's own create timestamp. A value
 * that parses to the Unix epoch (0) or is missing is ignored (it means "no
 * meaningful date recorded").
 *
 * Fallback: the OSM PBF file's mtime, so a date is still shown when the
 * metadata carries none. Returns null when neither yields a usable date.
 */
export function readOsmDataDate(mbtilesFile: string, osmFile: string): string | null {
  const fromMetadata = readMetadataDate(mbtilesFile);
  if (fromMetadata !== null) return fromMetadata;
  return fileMtimeDate(osmFile);
}

const REPLICATION_META = "planetiler:osm:osmosisreplicationtime";

function readMetadataDate(mbtilesFile: string): string | null {
  try {
    const db = new Database(mbtilesFile, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare("SELECT value FROM metadata WHERE name = ?")
        .get(REPLICATION_META) as { value: string } | undefined;
      if (row?.value) {
        const t = Date.parse(row.value);
        if (Number.isFinite(t) && t > 0) return new Date(t).toISOString().slice(0, 10);
      }
    } finally {
      db.close();
    }
  } catch {
    // No readable metadata — fall back to the file mtime.
  }
  return null;
}

function fileMtimeDate(osmFile: string): string | null {
  try {
    if (existsSync(osmFile)) {
      const m = statSync(osmFile).mtimeMs;
      if (Number.isFinite(m) && m > 0) return new Date(m).toISOString().slice(0, 10);
    }
  } catch {
    // Unreadable file — no date.
  }
  return null;
}
