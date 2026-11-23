/**
 * Compiled Ren'Py script (.rpyc / .rpymc) container reader.
 *
 * Layouts
 *   RPYC2  "RENPY RPC2" + repeated (slot, start, length) uint32-LE triplets,
 *          terminated by slot 0. Slot 1 holds zlib(pickle((data, stmts))).
 *   RPYC1  The whole file is zlib(pickle((data, stmts))) (Ren'Py ≤ 6.17).
 *
 * Some games tamper with the header. As a fallback we probe for zlib stream
 * headers and accept the first one that inflates and unpickles to a
 * `(data, stmts)` pair.
 */

import { inflate } from 'pako';
import { unpickle } from './pickle';

export interface RpycFile {
  /** Header dict: version, key, etc. (a Map, or null if absent). */
  data: Map<unknown, unknown> | null;
  /** Top-level AST statements (renpy.ast.* PyObjects). */
  stmts: unknown[];
  format: 'RPC2' | 'RPC1' | 'probed';
}

export class RpycError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpycError';
  }
}

const RPC2_MAGIC = [0x52, 0x45, 0x4e, 0x50, 0x59, 0x20, 0x52, 0x50, 0x43, 0x32]; // "RENPY RPC2"
const MAX_PROBES = 24;

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

/** Reads the RPC2 slot table: slot number → [start, length]. */
export function readRpc2Slots(bytes: Uint8Array): Map<number, [number, number]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const slots = new Map<number, [number, number]>();
  let pos = RPC2_MAGIC.length;
  while (pos + 12 <= bytes.length) {
    const slot = view.getUint32(pos, true);
    if (slot === 0) break;
    const start = view.getUint32(pos + 4, true);
    const length = view.getUint32(pos + 8, true);
    pos += 12;
    if (start + length <= bytes.length) slots.set(slot, [start, length]);
    if (slots.size > 64) break; // corrupt table
  }
  return slots;
}

function tryInflate(bytes: Uint8Array): Uint8Array | null {
  try {
    const out = inflate(bytes);
    return out && out.length ? out : null;
  } catch {
    return null; // pako 2 throws plain strings
  }
}

function asPair(value: unknown): { data: Map<unknown, unknown> | null; stmts: unknown[] } | null {
  if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[1])) return null;
  return { data: value[0] instanceof Map ? value[0] : null, stmts: value[1] };
}

function decodePayload(compressed: Uint8Array): { data: Map<unknown, unknown> | null; stmts: unknown[] } | null {
  const raw = tryInflate(compressed);
  if (!raw) return null;
  return asPair(unpickle(raw));
}

function isZlibHeader(a: number, b: number): boolean {
  return (a & 0x0f) === 8 && (a >> 4) <= 7 && ((a << 8) | b) % 31 === 0;
}

export function decodeRpyc(bytes: Uint8Array): RpycFile {
  if (startsWith(bytes, RPC2_MAGIC)) {
    const slots = readRpc2Slots(bytes);
    // Slot 1 is the AST; try the others only if it's missing or broken.
    const order = [...slots.keys()].sort((a, b) => (a === 1 ? -1 : b === 1 ? 1 : a - b));
    let lastError: unknown;
    for (const slot of order) {
      const [start, length] = slots.get(slot)!;
      try {
        const pair = decodePayload(bytes.subarray(start, start + length));
        if (pair) return { ...pair, format: 'RPC2' };
      } catch (e) {
        lastError = e;
      }
    }
    if (lastError) throw new RpycError(`RPC2 payload could not be read: ${(lastError as Error).message ?? lastError}`);
  } else {
    const pair = (() => {
      try {
        return decodePayload(bytes);
      } catch {
        return null;
      }
    })();
    if (pair) return { ...pair, format: 'RPC1' };
  }

  // Fallback: probe for embedded zlib streams (tampered headers).
  let probes = 0;
  for (let i = 0; i + 2 < bytes.length && probes < MAX_PROBES; i++) {
    if (!isZlibHeader(bytes[i], bytes[i + 1])) continue;
    probes++;
    try {
      const pair = decodePayload(bytes.subarray(i));
      if (pair) return { ...pair, format: 'probed' };
    } catch {
      /* keep probing */
    }
  }
  throw new RpycError('Not a readable .rpyc file (no compressed AST found)');
}
