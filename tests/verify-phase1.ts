/**
 * Phase 1 verification: runs Python-generated pickles and archives through
 * pickle.ts and rpaParser.ts.
 *
 *   python3 tests/fixtures/gen_fixtures.py tests/fixtures/out
 *   npx tsx tests/verify-phase1.ts tests/fixtures/out
 */
import { closeSync, fstatSync, openAsBlob, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { PyObject, PyPersistentRef, unpickle } from '../src/lib/pickle';
import { entryBlob, parseRpaIndex, parseRpiIndex, readEntry, type RpaArchive } from '../src/lib/rpaParser';

const dir = process.argv[2] ?? 'tests/fixtures/out';
let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Returns '' on match, otherwise a description of the first mismatch. */
function match(exp: any, act: unknown, path = '$'): string {
  if (exp === null) return act === null ? '' : `${path}: expected None, got ${String(act)}`;
  if (typeof exp === 'boolean') return act === exp ? '' : `${path}: expected ${exp}, got ${String(act)}`;
  if (typeof exp === 'string') return act === exp ? '' : `${path}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(act)}`;
  if ('$i' in exp) {
    if (typeof act !== 'number' && typeof act !== 'bigint') return `${path}: expected int, got ${typeof act}`;
    if (typeof act === 'number' && !Number.isSafeInteger(act)) return `${path}: unsafe number ${act}`;
    return BigInt(act) === BigInt(exp.$i) ? '' : `${path}: expected ${exp.$i}, got ${String(act)}`;
  }
  if ('$f' in exp) {
    const e = exp.$f === 'nan' ? NaN : exp.$f === 'inf' ? Infinity : exp.$f === '-inf' ? -Infinity : exp.$f;
    return Object.is(e, act) || (e === act) ? '' : `${path}: expected ${e}, got ${String(act)}`;
  }
  if ('$b' in exp) return act instanceof Uint8Array && hex(act) === exp.$b ? '' : `${path}: bytes mismatch`;
  if ('$t' in exp || '$l' in exp) {
    const items = exp.$t ?? exp.$l;
    if (!Array.isArray(act)) return `${path}: expected array, got ${act?.constructor?.name}`;
    if (act.length !== items.length) return `${path}: length ${act.length} != ${items.length}`;
    for (let i = 0; i < items.length; i++) {
      const m = match(items[i], act[i], `${path}[${i}]`);
      if (m) return m;
    }
    return '';
  }
  if ('$d' in exp) {
    if (!(act instanceof Map)) return `${path}: expected Map, got ${act?.constructor?.name}`;
    if (act.size !== exp.$d.length) return `${path}: map size ${act.size} != ${exp.$d.length}`;
    const actEntries = [...act.entries()];
    for (const [ek, ev] of exp.$d) {
      const found = actEntries.find(([k]) => match(ek, k) === '');
      if (!found) return `${path}: missing key ${JSON.stringify(ek)}`;
      const m = match(ev, found[1], `${path}[${JSON.stringify(ek)}]`);
      if (m) return m;
    }
    return '';
  }
  if ('$set' in exp) {
    if (!(act instanceof Set)) return `${path}: expected Set, got ${act?.constructor?.name}`;
    if (act.size !== exp.$set.length) return `${path}: set size ${act.size} != ${exp.$set.length}`;
    for (const e of exp.$set) if (![...act].some((a) => match(e, a) === '')) return `${path}: set missing ${JSON.stringify(e)}`;
    return '';
  }
  if ('$o' in exp) {
    if (!(act instanceof PyObject)) return `${path}: expected PyObject ${exp.$o}, got ${act?.constructor?.name}`;
    if (act.cls.qualifiedName !== exp.$o) return `${path}: class ${act.cls.qualifiedName} != ${exp.$o}`;
    if ('state' in exp) return match(exp.state, act.state, `${path}.state`);
    for (const [k, v] of Object.entries(exp.attrs)) {
      if (!act.attrs.has(k)) return `${path}: missing attr ${k}`;
      const m = match(v, act.attrs.get(k), `${path}.${k}`);
      if (m) return m;
    }
    return '';
  }
  if ('$persid' in exp) {
    return act instanceof PyPersistentRef ? match(exp.$persid, act.pid, `${path}.pid`) : `${path}: expected persistent ref`;
  }
  return `${path}: unknown expectation ${JSON.stringify(exp)}`;
}

// ── pickles ──────────────────────────────────────────────────────────────
type Fixture = { name: string; proto: number; b64: string; expected: any; buffers?: string[] };
const fixtures: Fixture[] = JSON.parse(readFileSync(join(dir, 'pickles.json'), 'utf8'));
const BYTES_MODE = new Set(['py2_short_binstring', 'py2_binstring', 'py2_proto0_string', 'persid']);
const extensions = new Map<number, [string, string]>([[7, ['renpy.ast', 'Say']]]);

for (const f of fixtures) {
  const label = `pickle ${f.name} p${f.proto}`;
  try {
    const data = Buffer.from(f.b64, 'base64');
    const buffers = f.buffers?.map((b) => new Uint8Array(Buffer.from(b, 'base64')));
    const encoding = BYTES_MODE.has(f.name) ? ('bytes' as const) : undefined;
    const v = unpickle(new Uint8Array(data), { extensions, buffers, encoding });
    if (f.name === 'shared_ref') {
      check(label, Array.isArray(v) && v[0] === v[1] && Array.isArray(v[0]), 'memo identity lost');
    } else if (f.name === 'recursive_list') {
      check(label, Array.isArray(v) && v[0] === v, 'recursive identity lost');
    } else {
      const m = match(f.expected, v);
      check(label, m === '', m);
    }
  } catch (e) {
    check(label, false, String(e));
  }
}

// Error handling: truncated and garbage streams must throw, never hang.
for (const [name, bytes] of [
  ['truncated', Buffer.from(fixtures[0].b64, 'base64').subarray(0, 3)],
  ['garbage', Buffer.from([0x80, 0x02, 0xff, 0x00])],
  ['underflow', Buffer.from([0x80, 0x02, 0x61, 0x2e])],
] as const) {
  let threw = false;
  try { unpickle(new Uint8Array(bytes)); } catch { threw = true; }
  check(`pickle error ${name}`, threw, 'did not throw');
}

// ── archives ─────────────────────────────────────────────────────────────
const meta = JSON.parse(readFileSync(join(dir, 'archives.json'), 'utf8')) as {
  archives: { file: string; version: string }[];
  files: Record<string, string>;
};

/**
 * Node's openAsBlob() wraps sizes at 4 GiB, so for the 5 GiB sparse archive use
 * a minimal fs-backed stand-in with browser File semantics (size + lazy slice).
 */
function fsBlob(path: string): Blob {
  const fd = openSync(path, 'r');
  const size = fstatSync(fd).size;
  process.on('exit', () => closeSync(fd));
  // Top level exposes the true size; slices are read eagerly into real Blobs
  // (every slice the parser takes here is small: header, index, entries).
  return {
    size,
    type: '',
    slice(start = 0, end = size) {
      const buf = Buffer.alloc(Math.max(0, Math.min(end, size) - start));
      readSync(fd, buf, 0, buf.length, start);
      return new Blob([buf]);
    },
  } as unknown as Blob;
}

async function verifyArchive(label: string, archive: Blob, parsed: RpaArchive, expectVersion: string) {
  check(`${label} version`, parsed.version === expectVersion, parsed.version);
  check(`${label} count`, parsed.fileCount === Object.keys(meta.files).length, `${parsed.fileCount}`);
  check(`${label} no skipped`, parsed.skipped.length === 0, parsed.skipped.join(','));
  for (const [name, hexData] of Object.entries(meta.files)) {
    const entry = parsed.index[name];
    if (!entry) { check(`${label} has ${name}`, false); continue; }
    const viaRead = await readEntry(archive, entry);
    const viaBlob = new Uint8Array(await entryBlob(archive, entry).arrayBuffer());
    check(`${label} ${name} readEntry`, hex(viaRead) === hexData, `len ${viaRead.length}`);
    check(`${label} ${name} entryBlob`, hex(viaBlob) === hexData, `len ${viaBlob.length}`);
  }
}

for (const a of meta.archives) {
  const label = `archive ${a.file}`;
  try {
    const path = join(dir, a.file);
    const blob = a.file === 'huge_sparse.rpa' ? fsBlob(path) : await openAsBlob(path); // lazily sliced, like a browser File
    const parsed = await parseRpaIndex(blob);
    await verifyArchive(label, blob, parsed, a.version);
    if (a.file === 'huge_sparse.rpa') {
      const min = Math.min(...Object.values(parsed.index).map((e) => e.offset));
      check(`${label} offsets > 4 GiB`, min > 2 ** 32, String(min));
    }
    if (a.file === 'py2_prefix_split.rpa') {
      check(`${label} prefix kept`, parsed.index['images/bg beach.png']?.prefix?.length === 8);
      check(`${label} split segments`, parsed.index['video/op.webm']?.segments?.length === 2);
    }
  } catch (e) {
    check(label, false, String(e));
  }
}

try {
  const data = await openAsBlob(join(dir, 'v1.rpa'));
  const rpi = await openAsBlob(join(dir, 'v1.rpi'));
  await verifyArchive('archive v1 (.rpi)', data, await parseRpiIndex(rpi, data), 'RPA-1.0');
} catch (e) {
  check('archive v1 (.rpi)', false, String(e));
}

// Not-an-archive must give a friendly error.
try {
  await parseRpaIndex(new Blob(['hello world, definitely not an archive\n']));
  check('rejects non-archive', false, 'no error');
} catch (e) {
  check('rejects non-archive', /Not a Ren'Py archive/.test(String(e)), String(e));
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  ✗ ' + f);
process.exit(failures.length ? 1 : 0);
