import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIEW_MAX_ZOOM,
  formatViewHash,
  isValidLocation,
  parseViewHash,
} from "../shared/view-state.js";

test("formatViewHash: OSM-style #zoom/lat/lon", () => {
  assert.equal(
    formatViewHash({ lng: 5.321301, lat: 60.412102, zoom: 12.5 }),
    "#12.5/60.4121/5.3213",
  );
});

test("formatViewHash: rounds lat/lng to 5 dp and zoom to 2 dp", () => {
  assert.equal(
    formatViewHash({ lng: 5.123456789, lat: 60.987654321, zoom: 12.3456789 }),
    "#12.35/60.98765/5.12346",
  );
});

test("formatViewHash: rejects invalid locations (null, no throw)", () => {
  assert.equal(formatViewHash(null), null);
  assert.equal(formatViewHash({}), null);
  assert.equal(formatViewHash({ lng: NaN, lat: 1, zoom: 1 }), null);
  assert.equal(formatViewHash({ lng: 1, lat: 91, zoom: 1 }), null);
  assert.equal(formatViewHash({ lng: 1, lat: 1, zoom: -1 }), null);
  assert.equal(formatViewHash({ lng: 1, lat: 1, zoom: VIEW_MAX_ZOOM + 1 }), null);
});

test("parseViewHash: bare hash, OSM token order zoom/lat/lon", () => {
  assert.deepEqual(parseViewHash("#12.5/60.4121/5.3213"), {
    zoom: 12.5,
    lat: 60.4121,
    lng: 5.3213,
  });
});

test("parseViewHash: accepts a full URL (query + hash)", () => {
  assert.deepEqual(
    parseViewHash("https://example.com/mtb/?a=1#12.5/60.4121/5.3213"),
    { zoom: 12.5, lat: 60.4121, lng: 5.3213 },
  );
});

test("parseViewHash: boundary values are valid", () => {
  assert.deepEqual(parseViewHash("#0/0/0"), { zoom: 0, lat: 0, lng: 0 });
  assert.deepEqual(parseViewHash("#22/90/180"), { zoom: 22, lat: 90, lng: 180 });
  assert.deepEqual(parseViewHash("#22/-90/-180"), { zoom: 22, lat: -90, lng: -180 });
});

test("parseViewHash: roundtrip with formatViewHash (within rounding)", () => {
  const loc = { lng: 5.321301, lat: 60.412102, zoom: 12.5 };
  const parsed = parseViewHash(formatViewHash(loc));
  assert.equal(parsed.zoom, 12.5);
  assert.ok(Math.abs(parsed.lat - loc.lat) < 1e-5);
  assert.ok(Math.abs(parsed.lng - loc.lng) < 1e-5);
});

test("parseViewHash: malformed hashes are rejected (null, no throw)", () => {
  assert.equal(parseViewHash(""), null);
  assert.equal(parseViewHash("#"), null);
  assert.equal(parseViewHash("#12.5/60.4121"), null, "too few tokens");
  assert.equal(parseViewHash("#12.5/60.4121/5.3213/9"), null, "too many tokens");
  assert.equal(parseViewHash("#x/y/z"), null, "non-numeric");
  assert.equal(parseViewHash("#12.5/NaN/5.3213"), null);
  assert.equal(parseViewHash("#12.5/60.4121/"), null, "empty token");
  assert.equal(parseViewHash("no hash here"), null, "URL without a hash");
  assert.equal(parseViewHash(undefined), null);
  assert.equal(parseViewHash(42), null);
});

test("parseViewHash: out-of-range values are rejected", () => {
  assert.equal(parseViewHash("#12.5/91/5.3213"), null, "lat 91");
  assert.equal(parseViewHash("#12.5/-91/5.3213"), null, "lat -91");
  assert.equal(parseViewHash("#12.5/60.4121/181"), null, "lng 181");
  assert.equal(parseViewHash("#12.5/60.4121/-181"), null, "lng -181");
  assert.equal(parseViewHash("#-1/60.4121/5.3213"), null, "zoom -1");
  assert.equal(parseViewHash(`#${VIEW_MAX_ZOOM + 1}/60.4121/5.3213`), null, "zoom 23");
  assert.equal(parseViewHash("#NaN/60.4121/5.3213"), null, "zoom NaN");
});

test("isValidLocation: exact boundary check", () => {
  assert.equal(isValidLocation({ lng: -180, lat: -90, zoom: 0 }), true);
  assert.equal(isValidLocation({ lng: 180, lat: 90, zoom: VIEW_MAX_ZOOM }), true);
  assert.equal(isValidLocation({ lng: 181, lat: 0, zoom: 1 }), false);
});
