// Minimal hand-rolled Mapbox Vector Tile (protobuf) encoder for tests.
// Wire-compatible subset of https://github.com/mapbox/vector-tile-spec

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
}

function zigzag(n: number): number {
  return n < 0 ? -n * 2 - 1 : n * 2;
}

function tag(field: number, wire: number): number {
  return (field << 3) | wire;
}

function vint(field: number, value: number): number[] {
  return [...varint(tag(field, 0)), ...varint(value)];
}

function bytes(field: number, data: number[]): number[] {
  return [...varint(tag(field, 2)), ...varint(data.length), ...data];
}

function str(field: number, s: string): number[] {
  return bytes(field, [...Buffer.from(s, "utf8")]);
}

/** Value (oneof) — string_value */
export function stringVal(s: string): number[] {
  return str(1, s);
}

/** Point geometry (MoveTo + 1 coordinate). */
export function pointGeometry(x: number, y: number): number[] {
  const out: number[] = [];
  out.push(...vint(1, (1 << 3) | 1)); // MoveTo(1), count=1
  out.push(...varint(zigzag(x)));
  out.push(...varint(zigzag(y)));
  return out;
}

/** Feature — optional id, packed tags (repeated uint32) + geometry (bytes). */
export function feature(tags: number[], geometry: number[], id?: number): number[] {
  const out: number[] = [];
  if (id !== undefined) out.push(...vint(1, id));
  const tagBytes: number[] = [];
  for (const t of tags) tagBytes.push(...varint(t));
  out.push(...bytes(2, tagBytes));
  out.push(...bytes(3, geometry));
  return out;
}

/** Layer — name, features, keys, values, extent, version. */
export function layer(name: string, features: number[], keys: string[], values: number[]): number[] {
  const out: number[] = [...str(1, name)];
  for (const f of features) out.push(...bytes(2, f));
  for (const k of keys) out.push(...str(3, k));
  for (const v of values) out.push(...bytes(4, v));
  out.push(...vint(5, 4096));
  out.push(...vint(15, 2));
  return out;
}

/** Tile — repeated Layer (field 3). */
export function tileBytes(layers: number[]): Uint8Array {
  const out: number[] = [];
  for (const l of layers) out.push(...bytes(3, l));
  return new Uint8Array(out);
}
