import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export type GitObject = { type: GitObjectType; data: Buffer };
const codes: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const typeCodes: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const oid = (type: GitObjectType, data: Buffer) => createHash('sha1').update(Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data])).digest('hex');
export function pkt(s: string | Buffer) { const b = typeof s === 'string' ? Buffer.from(s) : s; return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); }
export const flush = () => Buffer.from('0000');
export function tree(entries: { mode: string; name: string; sha: string }[]) { return Buffer.concat(entries.map(e => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')]))); }
export function commit(treeId: string, parents: string[], message: string) { return Buffer.from(`tree ${treeId}\n${parents.map(p => `parent ${p}\n`).join('')}author Makefun <forge@local> 0 +0000\ncommitter Makefun <forge@local> 0 +0000\n\n${message}\n`); }

function readVarint(b: Buffer, state: { p: number }): number { let n = 0, shift = 0, c: number; do { if (state.p >= b.length || shift > 49) throw Error('bad delta varint'); c = b[state.p++]!; n += (c & 127) * 2 ** shift; shift += 7; } while (c & 128); return n; }
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const s = { p: 0 }, baseSize = readVarint(delta, s), resultSize = readVarint(delta, s);
  if (baseSize !== base.length) throw Error('delta base size mismatch');
  const chunks: Buffer[] = []; let size = 0;
  while (s.p < delta.length) {
    const op = delta[s.p++]!;
    if (op & 128) {
      let off = 0, len = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) off += delta[s.p++]! * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (1 << (i + 4))) len += delta[s.p++]! * 2 ** (8 * i);
      if (!len) len = 0x10000;
      if (off + len > base.length) throw Error('delta copy outside base');
      chunks.push(base.subarray(off, off + len)); size += len;
    } else if (op) {
      if (s.p + op > delta.length) throw Error('delta insert outside instructions');
      chunks.push(delta.subarray(s.p, s.p + op)); s.p += op; size += op;
    } else throw Error('invalid delta opcode');
  }
  const out = Buffer.concat(chunks, size); if (out.length !== resultSize) throw Error('delta result size mismatch'); return out;
}
function varint(n: number) { const a = [n & 127]; while ((n = Math.floor(n / 128))) a.unshift((n & 127) | 128); return Buffer.from(a); }
const deflateCache = new Map<string, Buffer>();
export function makePack(objects: Map<string, GitObject>) {
  const parts = [Buffer.from('PACK'), Buffer.from([0, 0, 0, 2]), Buffer.from([objects.size >>> 24, objects.size >>> 16 & 255, objects.size >>> 8 & 255, objects.size & 255])];
  for (const [id, o] of objects) { let n = o.data.length, b = (typeCodes[o.type] << 4) | (n & 15); n = Math.floor(n / 16); if (n) b |= 128; const hdr = [b]; while (n) { let c = n & 127; n = Math.floor(n / 128); if (n) c |= 128; hdr.push(c); } let deflated = deflateCache.get(id); if (!deflated) { deflated = deflateSync(o.data); deflateCache.set(id, deflated); } parts.push(Buffer.from(hdr), deflated); }
  const body = Buffer.concat(parts); return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
export function readPack(pack: Buffer, extraBases?: Map<string, GitObject>) {
  if (pack.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(pack.readUInt32BE(4))) throw Error('bad pack header');
  const version = pack.readUInt32BE(4), count = pack.readUInt32BE(8), entries: any[] = []; let p = 12;
  for (let i = 0; i < count; i++) {
    const start = p; let c = pack[p++]!, type = (c >> 4) & 7, size = c & 15, shift = 4;
    while (c & 128) { c = pack[p++]!; size += (c & 127) * 2 ** shift; shift += 7; }
    let baseOffset = -1, baseOid = '';
    if (type === 6) { c = pack[p++]!; let distance = c & 127; while (c & 128) { c = pack[p++]!; distance = ((distance + 1) * 128) + (c & 127); } baseOffset = start - distance; }
    else if (type === 7) { baseOid = pack.subarray(p, p + 20).toString('hex'); p += 20; }
    const inflated = inflateSync(pack.subarray(p, -20), { info: true }) as any, delta: Buffer = inflated.buffer, used: number = inflated.engine.bytesWritten; p += used;
    if (type < 6 && (!codes[type] || delta.length !== size)) throw Error('invalid pack object');
    entries.push({ type, size, data: delta, baseOffset, baseOid, offset: start });
  }
  if (p !== pack.length - 20 || !createHash('sha1').update(pack.subarray(0, -20)).digest().equals(pack.subarray(-20))) throw Error('bad pack checksum');
  const out = new Map<string, GitObject>(), resolved = new Map<number, GitObject>(); let pending = entries.slice();
  while (pending.length) { const next: any[] = []; let progress = false;
    for (const e of pending) { let obj: GitObject | undefined;
      if (e.type < 6) obj = { type: codes[e.type]!, data: e.data };
      else { const base = e.type === 6 ? resolved.get(e.baseOffset) : (out.get(e.baseOid) ?? extraBases?.get(e.baseOid)); if (!base) { next.push(e); continue; } const applied = applyDelta(base.data, e.data); obj = { type: base.type, data: applied }; }
      const id = oid(obj.type, obj.data); out.set(id, obj); resolved.set(e.offset, obj); progress = true;
    }
    if (!progress) throw Error('unresolved pack delta base'); pending = next;
  }
  return out;
}
export function pktRead(b: Buffer) { const out: Buffer[] = []; let p = 0; while (p + 4 <= b.length) { const n = parseInt(b.toString('ascii', p, p + 4), 16); p += 4; if (!n) break; if (n === 1 || n === 2) continue; if (n < 4 || p + n - 4 > b.length) break; out.push(b.subarray(p, p + n - 4)); p += n - 4; } return out; }
export function deltaForTest(base: Buffer, result: Buffer) {
  let prefix = 0; while (prefix < base.length && prefix < result.length && base[prefix] === result[prefix]) prefix++;
  const suffix = Buffer.from('round-trip delta'); const target = Buffer.concat([base.subarray(0, prefix), suffix]);
  const copy: number[] = [0x80 | 1 | 2 | 4 | 8]; const len = prefix; copy.push(len & 255, len >>> 8 & 255, len >>> 16 & 255); const insert = Buffer.concat([Buffer.from([suffix.length]), suffix]);
  const body = Buffer.concat([varint(base.length), varint(target.length), Buffer.from(copy), insert]); return { body, target };
}
