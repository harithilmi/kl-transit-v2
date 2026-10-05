interface Field { no: number; num: number; bytes: Uint8Array }

/** Minimal protobuf reader (saves a decoder library): one entry per field, `num` for numbers, `bytes` for strings/sub-messages */
function* fields(buf: Uint8Array): Generator<Field> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const none = new Uint8Array(0);
  let i = 0;
  const varint = () => { let v = 0, m = 1, b; do { b = buf[i++]; v += (b & 127) * m; m *= 128; } while (b & 128); return v; };
  while (i < buf.length) {
    const tag = varint(), wire = tag & 7, no = tag >>> 3;
    if (wire === 0) yield { no, num: varint(), bytes: none };
    else if (wire === 2) { const n = varint(); yield { no, num: 0, bytes: buf.subarray(i, i + n) }; i += n; }
    else if (wire === 5) { yield { no, num: dv.getFloat32(i, true), bytes: none }; i += 4; }
    else if (wire === 1) i += 8;
    else return; // groups: not used by GTFS Realtime
  }
}

export interface Vehicle { id: string; route: string; lat: number; lng: number; bearing: number; speed: number; time: number }

/** FeedMessage → the fields we draw. Numbers below are the field ids in gtfs-realtime.proto */
export function parseVehicles(feed: Uint8Array) {
  const text = new TextDecoder();
  const out: Vehicle[] = [];
  for (const entity of fields(feed)) {
    if (entity.no !== 2) continue;
    for (const vehicle of fields(entity.bytes)) {
      if (vehicle.no !== 4) continue;
      const bus: Vehicle = { id: '', route: '', lat: 0, lng: 0, bearing: 0, speed: 0, time: 0 };
      for (const f of fields(vehicle.bytes)) {
        if (f.no === 1) { for (const t of fields(f.bytes)) if (t.no === 5) bus.route = text.decode(t.bytes); }
        else if (f.no === 2) {
          for (const p of fields(f.bytes)) {
            if (p.no === 1) bus.lat = p.num; else if (p.no === 2) bus.lng = p.num;
            else if (p.no === 3) bus.bearing = p.num; else if (p.no === 5) bus.speed = p.num;
          }
        } else if (f.no === 5) bus.time = f.num;
        else if (f.no === 8) { for (const d of fields(f.bytes)) if (d.no === 1) bus.id = text.decode(d.bytes); }
      }
      out.push(bus);
    }
  }
  return out;
}
