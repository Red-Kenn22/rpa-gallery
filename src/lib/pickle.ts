/**
 * Minimal, dependency-free Python pickle reader (protocols 0–5).
 *
 * Built for two jobs:
 *   1. Ren'Py `.rpa` archive indexes  – dict[str, list[tuple[int, int, bytes?]]]
 *   2. Ren'Py `.rpyc` ASTs            – nested renpy.ast.* objects, revertable
 *                                        containers, PyExpr strings, slot state.
 *
 * It never executes anything. Python globals become inert `PyClass` references
 * and instances become `PyObject` records, unless a handler in the registry
 * maps them to a native JS value (list → Array, dict → Map, set → Set, …).
 *
 * Python → JS value mapping
 *   None              → null
 *   bool              → boolean
 *   int               → number (bigint when outside ±2^53-1)
 *   float             → number
 *   str               → string
 *   bytes / bytearray → Uint8Array
 *   Py2 str           → see `UnpicklerOptions.encoding`
 *   list / tuple      → Array          (tuples are plain arrays too)
 *   dict              → Map            (keys keep their JS types)
 *   set / frozenset   → Set
 *   other instances   → PyObject       (attributes in `.attrs`)
 *
 * Runs unchanged in a Web Worker (no DOM APIs used).
 */

// ─── Public value types ─────────────────────────────────────────────────────

export type PyDict = Map<unknown, unknown>;

/** A reference to a Python global (class or function), e.g. `renpy.ast.Say`. */
export class PyClass {
  readonly module: string;
  readonly name: string;

  constructor(module: string, name: string) {
    this.module = module;
    this.name = name;
  }

  get qualifiedName(): string {
    return `${this.module}.${this.name}`;
  }

  toString(): string {
    return `<class '${this.qualifiedName}'>`;
  }
}

/** An instance of a Python class that has no native JS mapping. */
export class PyObject {
  readonly cls: PyClass;
  /** Positional args given to the constructor / `__new__` / reduce callable. */
  args: unknown[];
  kwargs: PyDict | undefined;
  /** Instance attributes: `__dict__` and `__slots__` state merged together. */
  readonly attrs: Map<string, unknown> = new Map();
  /**
   * Raw state for objects that use a custom `__setstate__` with a non-dict
   * payload (e.g. `renpy.ast.PyCode` pickles a tuple). `undefined` otherwise.
   */
  state: unknown = undefined;
  /** Items appended to a list subclass we don't map natively. */
  listItems: unknown[] | undefined;
  /** Items set on a dict subclass we don't map natively. */
  dictItems: PyDict | undefined;

  constructor(cls: PyClass, args: unknown[] = [], kwargs?: PyDict) {
    this.cls = cls;
    this.args = args;
    this.kwargs = kwargs;
  }

  get className(): string {
    return this.cls.qualifiedName;
  }

  get(attr: string): unknown {
    return this.attrs.get(attr);
  }

  has(attr: string): boolean {
    return this.attrs.has(attr);
  }
}

/** Placeholder produced for persistent IDs when no `persistentLoad` is given. */
export class PyPersistentRef {
  readonly pid: unknown;
  constructor(pid: unknown) {
    this.pid = pid;
  }
}

export class UnpicklingError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(`${message} (at byte ${position})`);
    this.name = 'UnpicklingError';
    this.position = position;
  }
}

// ─── Extension points ───────────────────────────────────────────────────────

export interface PyCallContext {
  /** The global being invoked. */
  readonly cls: PyClass;
  /** Creates an instance of `target` with NEWOBJ (`cls.__new__`) semantics. */
  construct(target: unknown, args: unknown[], kwargs?: PyDict): unknown;
  /** Invokes `target(*args)` with REDUCE semantics. */
  call(target: unknown, args: unknown[]): unknown;
}

export type PyCallHandler = (
  args: unknown[],
  kwargs: PyDict | undefined,
  ctx: PyCallContext,
) => unknown;

/**
 * How a global behaves when a pickle calls it.
 * `call` handles REDUCE/INST/OBJ (`f(*args)`), `construct` handles
 * NEWOBJ/NEWOBJ_EX (`cls.__new__(cls, *args)`). If only one is given it is
 * used for both.
 */
export interface PyGlobalHandler {
  call?: PyCallHandler;
  construct?: PyCallHandler;
}

export interface UnpicklerOptions {
  /**
   * How to decode Python 2 `str` values (STRING / BINSTRING / SHORT_BINSTRING):
   *   'utf8'   – decode as UTF-8, falling back to Latin-1 for invalid bytes (default)
   *   'latin1' – decode byte-for-byte (lossless round-trip)
   *   'bytes'  – keep as Uint8Array (Python's `encoding="bytes"`)
   */
  encoding?: 'utf8' | 'latin1' | 'bytes';
  /** Extra / overriding handlers, keyed by `"module.name"`. */
  globals?: Record<string, PyGlobalHandler>;
  /** Resolves PERSID / BINPERSID. Default: wrap in `PyPersistentRef`. */
  persistentLoad?: (pid: unknown) => unknown;
  /** copyreg extension registry for EXT1/EXT2/EXT4: code → [module, name]. */
  extensions?: Map<number, [string, string]>;
  /** Out-of-band buffers for protocol 5 NEXT_BUFFER. */
  buffers?: Iterable<Uint8Array>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

function normalizeInt(v: bigint): number | bigint {
  return v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : v;
}

/** Little-endian two's-complement integer, as used by LONG1 / LONG4. */
export function decodeLong(bytes: Uint8Array): number | bigint {
  const n = bytes.length;
  if (n === 0) return 0;
  if (n <= 6) {
    let v = 0;
    for (let i = n - 1; i >= 0; i--) v = v * 256 + bytes[i];
    if (bytes[n - 1] & 0x80) v -= 2 ** (8 * n);
    return v;
  }
  let v = 0n;
  for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  if (bytes[n - 1] & 0x80) v -= 1n << BigInt(8 * n);
  return normalizeInt(v);
}

function parseDecimalInt(text: string, pos: number): number | bigint {
  const t = text.trim();
  if (!/^[+-]?\d+$/.test(t)) throw new UnpicklingError(`invalid integer literal ${JSON.stringify(text)}`, pos);
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : normalizeInt(BigInt(t));
}

function parseFloatLiteral(text: string, pos: number): number {
  const t = text.trim().toLowerCase();
  if (t === 'inf' || t === '+inf') return Infinity;
  if (t === '-inf') return -Infinity;
  if (t === 'nan' || t === '+nan' || t === '-nan') return NaN;
  const v = Number(t);
  if (Number.isNaN(v)) throw new UnpicklingError(`invalid float literal ${JSON.stringify(text)}`, pos);
  return v;
}

export function latin1Decode(bytes: Uint8Array): string {
  // Chunked to stay under engine argument limits.
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return out;
}

export function latin1Encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

const utf8Decoder = new TextDecoder('utf-8');
const utf8StrictDecoder = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

/**
 * UTF-8 decode with a fast path for short ASCII strings — TextDecoder has a
 * high fixed cost per call, and AST pickles are mostly tiny identifiers.
 */
function decodeUtf8(bytes: Uint8Array): string {
  const n = bytes.length;
  if (n < 64) {
    let ascii = true;
    for (let i = 0; i < n; i++) {
      if (bytes[i] > 0x7f) {
        ascii = false;
        break;
      }
    }
    if (ascii) return String.fromCharCode.apply(null, bytes as unknown as number[]);
  }
  return utf8Decoder.decode(bytes);
}

function utf8OrLatin1(bytes: Uint8Array): string {
  try {
    return utf8StrictDecoder.decode(bytes);
  } catch {
    return latin1Decode(bytes);
  }
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  return -1;
}

/** Decodes the body of a protocol-0 STRING (Python `repr(bytes)` escapes). */
function decodeEscapedBytes(body: string, pos: number): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body.charCodeAt(i);
    if (ch !== 0x5c /* \ */) {
      out.push(ch & 0xff);
      continue;
    }
    i++;
    if (i >= body.length) throw new UnpicklingError('trailing backslash in STRING', pos);
    const e = body[i];
    switch (e) {
      case '\n': break; // line continuation
      case '\\': out.push(0x5c); break;
      case "'": out.push(0x27); break;
      case '"': out.push(0x22); break;
      case 'a': out.push(0x07); break;
      case 'b': out.push(0x08); break;
      case 'f': out.push(0x0c); break;
      case 'n': out.push(0x0a); break;
      case 'r': out.push(0x0d); break;
      case 't': out.push(0x09); break;
      case 'v': out.push(0x0b); break;
      case 'x': {
        const h1 = hexVal(body.charCodeAt(i + 1));
        const h2 = hexVal(body.charCodeAt(i + 2));
        if (h1 < 0 || h2 < 0) throw new UnpicklingError('invalid \\x escape in STRING', pos);
        out.push(h1 * 16 + h2);
        i += 2;
        break;
      }
      default: {
        if (e >= '0' && e <= '7') {
          let v = 0;
          let n = 0;
          while (n < 3 && i < body.length && body[i] >= '0' && body[i] <= '7') {
            v = v * 8 + (body.charCodeAt(i) - 0x30);
            i++;
            n++;
          }
          i--;
          out.push(v & 0xff);
        } else {
          // Unknown escapes are kept verbatim, as Python does.
          out.push(0x5c, body.charCodeAt(i) & 0xff);
        }
      }
    }
  }
  return Uint8Array.from(out);
}

/** Decodes a protocol-0 UNICODE argument (`raw-unicode-escape`). */
function decodeRawUnicodeEscape(raw: string, pos: number): string {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    // Count the run of backslashes; only an odd run escapes the next u/U.
    let j = i;
    while (j < raw.length && raw[j] === '\\') j++;
    const run = j - i;
    const next = raw[j];
    if (run % 2 === 1 && (next === 'u' || next === 'U')) {
      out += '\\'.repeat(run - 1);
      const digits = next === 'u' ? 4 : 8;
      const hex = raw.substr(j + 1, digits);
      if (hex.length !== digits || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new UnpicklingError('truncated \\uXXXX escape in UNICODE', pos);
      }
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff) throw new UnpicklingError('\\U escape out of range', pos);
      out += String.fromCodePoint(cp);
      i = j + 1 + digits;
    } else {
      out += '\\'.repeat(run);
      i = j;
    }
  }
  return out;
}

function iterToArray(v: unknown): unknown[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.slice();
  if (v instanceof Map) return [...v.keys()];
  if (v instanceof Set) return [...v];
  if (v instanceof Uint8Array) return Array.from(v);
  if (typeof v === 'string') return [...v];
  if (v instanceof PyObject && v.listItems) return v.listItems.slice();
  return [];
}

function toMap(v: unknown): PyDict {
  if (v instanceof Map) return new Map(v);
  const m: PyDict = new Map();
  if (v instanceof PyObject && v.dictItems) return new Map(v.dictItems);
  for (const pair of iterToArray(v)) {
    if (Array.isArray(pair) && pair.length === 2) m.set(pair[0], pair[1]);
  }
  return m;
}

function attrName(key: unknown): string {
  if (typeof key === 'string') return key;
  if (key instanceof Uint8Array) return latin1Decode(key);
  return String(key);
}

function encodeWith(text: string, encoding: unknown): Uint8Array {
  const enc = typeof encoding === 'string' ? encoding.toLowerCase().replace(/_/g, '-') : 'utf-8';
  if (enc === 'latin1' || enc === 'latin-1' || enc === 'iso-8859-1' || enc === 'iso8859-1' || enc === 'l1') {
    return latin1Encode(text);
  }
  if (enc === 'ascii' || enc === 'us-ascii') return latin1Encode(text);
  return utf8Encoder.encode(text);
}

function toBytes(args: unknown[]): Uint8Array {
  const [src, encoding] = args;
  if (src == null) return new Uint8Array(0);
  if (src instanceof Uint8Array) return src.slice();
  if (typeof src === 'string') return encodeWith(src, encoding);
  if (typeof src === 'number') return new Uint8Array(src);
  return Uint8Array.from(iterToArray(src).map((n) => Number(n) & 0xff));
}

function hiddenProp(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: false, configurable: true, writable: true });
}

// ─── Built-in global registry ───────────────────────────────────────────────

/** Python 2 → Python 3 module/name renames (subset of `_compat_pickle`). */
const MODULE_RENAMES: Record<string, string> = {
  __builtin__: 'builtins',
  copy_reg: 'copyreg',
  UserDict: 'collections',
  UserList: 'collections',
  _abcoll: 'collections.abc',
};
const NAME_RENAMES: Record<string, string> = {
  'builtins.unicode': 'builtins.str',
  'builtins.long': 'builtins.int',
  'builtins.basestring': 'builtins.str',
  'builtins.xrange': 'builtins.range',
  'builtins.reduce': 'functools.reduce',
  'collections.IterableUserDict': 'collections.UserDict',
};

function canonicalName(module: string, name: string): string {
  const mod = MODULE_RENAMES[module] ?? module;
  const full = `${mod}.${name}`;
  return NAME_RENAMES[full] ?? full;
}

const listHandler: PyGlobalHandler = { call: (a) => iterToArray(a[0]) };
const dictHandler: PyGlobalHandler = {
  call: (a, kw) => {
    const m = toMap(a[0]);
    if (kw) for (const [k, v] of kw) m.set(k, v);
    return m;
  },
};
const setHandler: PyGlobalHandler = { call: (a) => new Set(iterToArray(a[0])) };
const bytesHandler: PyGlobalHandler = { call: (a) => toBytes(a) };
const objectHandler: PyGlobalHandler = { call: (a, kw, ctx) => new PyObject(ctx.cls, a, kw) };
const pyExprHandler: PyGlobalHandler = {
  // renpy.ast.PyExpr is a str subclass whose __getnewargs__ is
  // (source, filename, linenumber[, py]). We keep only the source text.
  call: (a) => (typeof a[0] === 'string' ? a[0] : a[0] instanceof Uint8Array ? utf8OrLatin1(a[0]) : String(a[0] ?? '')),
};

export const DEFAULT_GLOBALS: Record<string, PyGlobalHandler> = {
  'builtins.list': listHandler,
  'builtins.tuple': listHandler,
  'builtins.dict': dictHandler,
  'builtins.set': setHandler,
  'builtins.frozenset': setHandler,
  'builtins.bytes': bytesHandler,
  'builtins.bytearray': bytesHandler,
  'builtins.object': objectHandler,
  'builtins.str': { call: (a) => (a.length ? (a[0] instanceof Uint8Array ? utf8OrLatin1(a[0]) : String(a[0])) : '') },
  'builtins.int': {
    call: (a) => {
      const v = a[0];
      if (typeof v === 'number') return Math.trunc(v);
      if (typeof v === 'bigint') return v;
      if (typeof v === 'string') {
        const base = typeof a[1] === 'number' ? a[1] : 10;
        return base === 10 ? parseDecimalInt(v, -1) : parseInt(v, base);
      }
      return 0;
    },
  },
  'builtins.float': { call: (a) => (typeof a[0] === 'string' ? parseFloatLiteral(a[0], -1) : Number(a[0] ?? 0)) },
  'builtins.bool': { call: (a) => Boolean(a[0]) },
  'builtins.getattr': {
    call: (a) => {
      const [obj, name] = a;
      if (obj instanceof PyClass) return new PyClass(obj.module, `${obj.name}.${attrName(name)}`);
      if (obj instanceof PyObject) return obj.attrs.get(attrName(name));
      return undefined;
    },
  },

  'copyreg._reconstructor': {
    // copyreg._reconstructor(cls, base, state): base.__new__(cls, state) + base.__init__
    call: (a, _kw, ctx) => {
      const [cls, base, state] = a;
      const baseName = base instanceof PyClass ? canonicalName(base.module, base.name) : 'builtins.object';
      if (baseName === 'builtins.object' || state == null) return ctx.construct(cls, []);
      return ctx.construct(cls, [state]);
    },
  },
  'copyreg.__newobj__': { call: (a, _kw, ctx) => ctx.construct(a[0], a.slice(1)) },
  'copyreg.__newobj_ex__': {
    call: (a, _kw, ctx) => ctx.construct(a[0], iterToArray(a[1]), a[2] instanceof Map ? a[2] : undefined),
  },
  // Python 3 pickles `bytes` at protocol < 3 as _codecs.encode(latin1_str, 'latin1').
  '_codecs.encode': { call: (a) => (typeof a[0] === 'string' ? encodeWith(a[0], a[1]) : toBytes(a)) },
  'codecs.encode': { call: (a) => (typeof a[0] === 'string' ? encodeWith(a[0], a[1]) : toBytes(a)) },

  'collections.OrderedDict': dictHandler,
  'collections.defaultdict': { call: (a) => toMap(a[1]) },
  'collections.Counter': dictHandler,
  'collections.UserDict': dictHandler,
  'collections.deque': listHandler,
  'collections.UserList': listHandler,

  // Ren'Py revertable containers (renpy.revertable in 8.x, renpy.python before).
  'renpy.revertable.RevertableList': listHandler,
  'renpy.revertable.RevertableDict': dictHandler,
  'renpy.revertable.RevertableSet': setHandler,
  'renpy.python.RevertableList': listHandler,
  'renpy.python.RevertableDict': dictHandler,
  'renpy.python.RevertableSet': setHandler,
  'store.RevertableList': listHandler,
  'store.RevertableDict': dictHandler,
  'store.RevertableSet': setHandler,

  'renpy.ast.PyExpr': pyExprHandler,
  'renpy.astsupport.PyExpr': pyExprHandler,
};

// ─── Opcodes ────────────────────────────────────────────────────────────────

/*
 * Opcode reference. Case labels in the dispatch switch are numeric literals
 * so V8 can compile it to a jump table.
 *
 *   MARK = 0x28, // (
 *   STOP = 0x2e, // .
 *   POP = 0x30, // 0
 *   POP_MARK = 0x31, // 1
 *   DUP = 0x32, // 2
 *   FLOAT = 0x46, // F
 *   INT = 0x49, // I
 *   BININT = 0x4a, // J
 *   BININT1 = 0x4b, // K
 *   LONG = 0x4c, // L
 *   BININT2 = 0x4d, // M
 *   NONE = 0x4e, // N
 *   PERSID = 0x50, // P
 *   BINPERSID = 0x51, // Q
 *   REDUCE = 0x52, // R
 *   STRING = 0x53, // S
 *   BINSTRING = 0x54, // T
 *   SHORT_BINSTRING = 0x55, // U
 *   UNICODE = 0x56, // V
 *   BINUNICODE = 0x58, // X
 *   APPEND = 0x61, // a
 *   BUILD = 0x62, // b
 *   GLOBAL = 0x63, // c
 *   DICT = 0x64, // d
 *   EMPTY_DICT = 0x7d, // }
 *   APPENDS = 0x65, // e
 *   GET = 0x67, // g
 *   BINGET = 0x68, // h
 *   INST = 0x69, // i
 *   LONG_BINGET = 0x6a, // j
 *   LIST = 0x6c, // l
 *   EMPTY_LIST = 0x5d, // ]
 *   OBJ = 0x6f, // o
 *   PUT = 0x70, // p
 *   BINPUT = 0x71, // q
 *   LONG_BINPUT = 0x72, // r
 *   SETITEM = 0x73, // s
 *   TUPLE = 0x74, // t
 *   EMPTY_TUPLE = 0x29, // )
 *   SETITEMS = 0x75, // u
 *   BINFLOAT = 0x47, // G
 *  // protocol 2
 *   PROTO = 0x80
 *   NEWOBJ = 0x81
 *   EXT1 = 0x82
 *   EXT2 = 0x83
 *   EXT4 = 0x84
 *   TUPLE1 = 0x85
 *   TUPLE2 = 0x86
 *   TUPLE3 = 0x87
 *   NEWTRUE = 0x88
 *   NEWFALSE = 0x89
 *   LONG1 = 0x8a
 *   LONG4 = 0x8b
 *  // protocol 3
 *   BINBYTES = 0x42, // B
 *   SHORT_BINBYTES = 0x43, // C
 *  // protocol 4
 *   SHORT_BINUNICODE = 0x8c
 *   BINUNICODE8 = 0x8d
 *   BINBYTES8 = 0x8e
 *   EMPTY_SET = 0x8f
 *   ADDITEMS = 0x90
 *   FROZENSET = 0x91
 *   NEWOBJ_EX = 0x92
 *   STACK_GLOBAL = 0x93
 *   MEMOIZE = 0x94
 *   FRAME = 0x95
 *  // protocol 5
 *   BYTEARRAY8 = 0x96
 *   NEXT_BUFFER = 0x97
 *   READONLY_BUFFER = 0x98
 */

// ─── Unpickler ──────────────────────────────────────────────────────────────

export class Unpickler {
  private readonly data: Uint8Array;
  private readonly view: DataView;
  private pos = 0;
  private stack: unknown[] = [];
  private marks: number[] = [];
  /** Dense array, not a Map: memo indices are sequential and can run to millions. */
  private memo: unknown[] = [];
  private readonly encoding: 'utf8' | 'latin1' | 'bytes';
  private readonly globals: Record<string, PyGlobalHandler>;
  private readonly persistentLoad?: (pid: unknown) => unknown;
  private readonly extensions?: Map<number, [string, string]>;
  private readonly extensionCache = new Map<number, PyClass>();
  private readonly handlerCache = new Map<PyClass, PyGlobalHandler | null>();
  private readonly buffers?: Iterator<Uint8Array>;
  private readonly ctxConstruct: PyCallContext['construct'];
  private readonly ctxCall: PyCallContext['call'];

  constructor(data: Uint8Array | ArrayBuffer, options: UnpicklerOptions = {}) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    this.encoding = options.encoding ?? 'utf8';
    this.globals = options.globals ? { ...DEFAULT_GLOBALS, ...options.globals } : DEFAULT_GLOBALS;
    this.persistentLoad = options.persistentLoad;
    this.extensions = options.extensions;
    this.buffers = options.buffers?.[Symbol.iterator]();
    this.ctxConstruct = (target, args, kwargs) => this.construct(target, args, kwargs);
    this.ctxCall = (target, args) => this.call(target, args);
  }

  /** Byte offset just past the STOP opcode once `load()` returns. */
  get offset(): number {
    return this.pos;
  }

  load(): unknown {
    const data = this.data;
    const end = data.length;

    while (this.pos < end) {
      const opPos = this.pos;
      const op = data[this.pos++];

      switch (op) {
        // ── framing / protocol ──
        case 0x80: { // PROTO
          const proto = this.u8();
          if (proto > 5) throw this.err(`unsupported pickle protocol ${proto}`, opPos);
          break;
        }
        case 0x95: // FRAME
          this.u64(); // frame length; we already hold the whole buffer
          break;
        case 0x2e: // STOP
          return this.pop();

        // ── stack manipulation ──
        case 0x28: // MARK
          this.marks.push(this.stack.length);
          break;
        case 0x30: // POP
          if (this.stack.length > this.markBase()) this.stack.pop();
          else this.popMark();
          break;
        case 0x31: // POP_MARK
          this.popMark();
          break;
        case 0x32: // DUP
          this.push(this.top());
          break;

        // ── constants ──
        case 0x4e: // NONE
          this.push(null);
          break;
        case 0x88: // NEWTRUE
          this.push(true);
          break;
        case 0x89: // NEWFALSE
          this.push(false);
          break;

        // ── integers ──
        case 0x49: { // INT
          const line = this.readLine();
          if (line === '00') this.push(false);
          else if (line === '01') this.push(true);
          else this.push(parseDecimalInt(line, opPos));
          break;
        }
        case 0x4a: // BININT
          this.need(4);
          this.push(this.view.getInt32(this.pos, true));
          this.pos += 4;
          break;
        case 0x4b: // BININT1
          this.push(this.u8());
          break;
        case 0x4d: // BININT2
          this.need(2);
          this.push(this.view.getUint16(this.pos, true));
          this.pos += 2;
          break;
        case 0x4c: { // LONG
          let line = this.readLine();
          if (line.endsWith('L')) line = line.slice(0, -1);
          this.push(parseDecimalInt(line, opPos));
          break;
        }
        case 0x8a: { // LONG1
          const n = this.u8();
          this.push(decodeLong(this.bytes(n)));
          break;
        }
        case 0x8b: { // LONG4
          const n = this.i32();
          if (n < 0) throw this.err('negative LONG4 byte count', opPos);
          this.push(decodeLong(this.bytes(n)));
          break;
        }

        // ── floats ──
        case 0x46: // FLOAT
          this.push(parseFloatLiteral(this.readLine(), opPos));
          break;
        case 0x47: // BINFLOAT
          this.need(8);
          this.push(this.view.getFloat64(this.pos, false));
          this.pos += 8;
          break;

        // ── Python 2 str ──
        case 0x53: { // STRING
          const line = this.readLine();
          const q = line[0];
          if (line.length < 2 || (q !== "'" && q !== '"') || line[line.length - 1] !== q) {
            throw this.err('the STRING opcode argument must be quoted', opPos);
          }
          this.push(this.legacyStr(decodeEscapedBytes(line.slice(1, -1), opPos)));
          break;
        }
        case 0x54: { // BINSTRING
          const n = this.i32();
          if (n < 0) throw this.err('negative BINSTRING length', opPos);
          this.push(this.legacyStr(this.bytes(n)));
          break;
        }
        case 0x55: // SHORT_BINSTRING
          this.push(this.legacyStr(this.bytes(this.u8())));
          break;

        // ── unicode ──
        case 0x56: // UNICODE
          this.push(decodeRawUnicodeEscape(this.readLine(), opPos));
          break;
        case 0x8c: // SHORT_BINUNICODE
          this.push(decodeUtf8(this.bytes(this.u8())));
          break;
        case 0x58: // BINUNICODE
          this.push(decodeUtf8(this.bytes(this.u32())));
          break;
        case 0x8d: // BINUNICODE8
          this.push(decodeUtf8(this.bytes(this.u64())));
          break;

        // ── bytes ──
        case 0x43: // SHORT_BINBYTES
          this.push(this.bytes(this.u8()).slice());
          break;
        case 0x42: // BINBYTES
          this.push(this.bytes(this.u32()).slice());
          break;
        case 0x8e: // BINBYTES8
          this.push(this.bytes(this.u64()).slice());
          break;
        case 0x96: // BYTEARRAY8
          this.push(this.bytes(this.u64()).slice());
          break;
        case 0x97: { // NEXT_BUFFER
          if (!this.buffers) throw this.err('pickle stream refers to out-of-band data but no buffers were given', opPos);
          const next = this.buffers.next();
          if (next.done) throw this.err('not enough out-of-band buffers', opPos);
          this.push(next.value);
          break;
        }
        case 0x98: // READONLY_BUFFER
          break; // read-only-ness has no JS equivalent

        // ── tuples ──
        case 0x29: // EMPTY_TUPLE
          this.push([]);
          break;
        case 0x74: // TUPLE
          this.push(this.popMark());
          break;
        case 0x85: // TUPLE1
          this.push([this.pop()]);
          break;
        case 0x86: { // TUPLE2
          const b = this.pop();
          const a = this.pop();
          this.push([a, b]);
          break;
        }
        case 0x87: { // TUPLE3
          const c = this.pop();
          const b = this.pop();
          const a = this.pop();
          this.push([a, b, c]);
          break;
        }

        // ── lists ──
        case 0x5d: // EMPTY_LIST
          this.push([]);
          break;
        case 0x6c: // LIST
          this.push(this.popMark());
          break;
        case 0x61: { // APPEND
          const v = this.pop();
          this.appendItems(this.top(), [v], opPos);
          break;
        }
        case 0x65: { // APPENDS
          const items = this.popMark();
          this.appendItems(this.top(), items, opPos);
          break;
        }

        // ── dicts ──
        case 0x7d: // EMPTY_DICT
          this.push(new Map());
          break;
        case 0x64: { // DICT
          const items = this.popMark();
          const m: PyDict = new Map();
          for (let i = 0; i + 1 < items.length; i += 2) m.set(items[i], items[i + 1]);
          this.push(m);
          break;
        }
        case 0x73: { // SETITEM
          const v = this.pop();
          const k = this.pop();
          this.setItems(this.top(), [k, v], opPos);
          break;
        }
        case 0x75: { // SETITEMS
          const items = this.popMark();
          this.setItems(this.top(), items, opPos);
          break;
        }

        // ── sets ──
        case 0x8f: // EMPTY_SET
          this.push(new Set());
          break;
        case 0x91: // FROZENSET
          this.push(new Set(this.popMark()));
          break;
        case 0x90: { // ADDITEMS
          const items = this.popMark();
          const target = this.top();
          if (target instanceof Set) for (const it of items) target.add(it);
          else if (target instanceof PyObject) (target.listItems ??= []).push(...items);
          else throw this.err('ADDITEMS target is not a set', opPos);
          break;
        }

        // ── memo ──
        case 0x70: // PUT
          this.memoPut(parseDecimalInt(this.readLine(), opPos), this.top(), opPos);
          break;
        case 0x71: // BINPUT
          this.memo[this.u8()] = this.top();
          break;
        case 0x72: // LONG_BINPUT
          this.memo[this.u32()] = this.top();
          break;
        case 0x94: // MEMOIZE
          this.memo.push(this.top());
          break;
        case 0x67: // GET
          this.push(this.memoGet(parseDecimalInt(this.readLine(), opPos), opPos));
          break;
        case 0x68: // BINGET
          this.push(this.memoGet(this.u8(), opPos));
          break;
        case 0x6a: // LONG_BINGET
          this.push(this.memoGet(this.u32(), opPos));
          break;

        // ── globals & extensions ──
        case 0x63: { // GLOBAL
          const module = utf8OrLatin1(latin1Encode(this.readLine()));
          const name = utf8OrLatin1(latin1Encode(this.readLine()));
          this.push(new PyClass(module, name));
          break;
        }
        case 0x93: { // STACK_GLOBAL
          const name = this.pop();
          const module = this.pop();
          if (typeof name !== 'string' || typeof module !== 'string') {
            throw this.err('STACK_GLOBAL requires str module and name', opPos);
          }
          this.push(new PyClass(module, name));
          break;
        }
        case 0x82: // EXT1
          this.push(this.extension(this.u8(), opPos));
          break;
        case 0x83: // EXT2
          this.need(2);
          this.push(this.extension(this.view.getUint16(this.pos, true), opPos));
          this.pos += 2;
          break;
        case 0x84: // EXT4
          this.push(this.extension(this.i32(), opPos));
          break;

        // ── object construction ──
        case 0x52: { // REDUCE
          const args = this.pop();
          const fn = this.pop();
          this.push(this.call(fn, Array.isArray(args) ? args : iterToArray(args)));
          break;
        }
        case 0x81: { // NEWOBJ
          const args = this.pop();
          const cls = this.pop();
          this.push(this.construct(cls, Array.isArray(args) ? args : iterToArray(args)));
          break;
        }
        case 0x92: { // NEWOBJ_EX
          const kwargs = this.pop();
          const args = this.pop();
          const cls = this.pop();
          this.push(this.construct(cls, iterToArray(args), kwargs instanceof Map ? kwargs : undefined));
          break;
        }
        case 0x69: { // INST
          const module = utf8OrLatin1(latin1Encode(this.readLine()));
          const name = utf8OrLatin1(latin1Encode(this.readLine()));
          const args = this.popMark();
          this.push(this.call(new PyClass(module, name), args));
          break;
        }
        case 0x6f: { // OBJ
          const items = this.popMark();
          if (items.length === 0) throw this.err('OBJ without a class', opPos);
          const cls = items.shift();
          this.push(this.call(cls, items));
          break;
        }
        case 0x62: { // BUILD
          const state = this.pop();
          this.build(this.top(), state);
          break;
        }

        // ── persistent IDs ──
        case 0x50: // PERSID
          this.push(this.resolvePersistent(this.readLine()));
          break;
        case 0x51: // BINPERSID
          this.push(this.resolvePersistent(this.pop()));
          break;

        default:
          throw this.err(`invalid load key 0x${op.toString(16).padStart(2, '0')}`, opPos);
      }
    }
    throw this.err('pickle data was truncated (no STOP opcode)', this.pos);
  }

  // ── object model ──

  private handlerFor(target: unknown): { handler?: PyGlobalHandler; cls: PyClass } {
    if (target instanceof PyClass) {
      let handler = this.handlerCache.get(target);
      if (handler === undefined) {
        handler = this.globals[canonicalName(target.module, target.name)] ?? null;
        this.handlerCache.set(target, handler);
      }
      return { handler: handler ?? undefined, cls: target };
    }
    return { cls: new PyClass('<unknown>', String(target)) };
  }

  private call(target: unknown, args: unknown[]): unknown {
    const { handler, cls } = this.handlerFor(target);
    const fn = handler?.call ?? handler?.construct;
    if (fn) return fn(args, undefined, { cls, construct: this.ctxConstruct, call: this.ctxCall });
    return new PyObject(cls, args);
  }

  private construct(target: unknown, args: unknown[], kwargs?: PyDict): unknown {
    const { handler, cls } = this.handlerFor(target);
    const fn = handler?.construct ?? handler?.call;
    if (fn) return fn(args, kwargs, { cls, construct: this.ctxConstruct, call: this.ctxCall });
    return new PyObject(cls, args, kwargs);
  }

  /** BUILD: `obj.__setstate__(state)` or `obj.__dict__.update(state)`. */
  private build(target: unknown, state: unknown): void {
    if (state == null) return;

    if (target instanceof Set) {
      // Ren'Py's RevertableSet.__getstate__ returns ({item: True, ...},)
      const src = Array.isArray(state) && state.length === 1 ? state[0] : state;
      for (const it of iterToArray(src)) target.add(it);
      return;
    }

    let dictState: unknown = state;
    let slotState: unknown = null;
    if (
      Array.isArray(state) &&
      state.length === 2 &&
      (state[0] == null || state[0] instanceof Map) &&
      (state[1] == null || state[1] instanceof Map)
    ) {
      dictState = state[0];
      slotState = state[1];
    }

    if (target instanceof PyObject) {
      if (dictState != null && !(dictState instanceof Map)) {
        target.state = state; // custom __setstate__ payload
        return;
      }
      if (dictState instanceof Map) for (const [k, v] of dictState) target.attrs.set(attrName(k), v);
      if (slotState instanceof Map) for (const [k, v] of slotState) target.attrs.set(attrName(k), v);
      return;
    }


    if (target !== null && typeof target === 'object') {
      // Native container (Array/Map/Uint8Array) with instance state — keep it
      // out of the way but reachable.
      const attrs = new Map<string, unknown>();
      if (dictState instanceof Map) for (const [k, v] of dictState) attrs.set(attrName(k), v);
      if (slotState instanceof Map) for (const [k, v] of slotState) attrs.set(attrName(k), v);
      if (attrs.size) hiddenProp(target, '__pyattrs__', attrs);
      else if (!(dictState instanceof Map)) hiddenProp(target, '__pystate__', state);
    }
    // Primitives (e.g. PyExpr collapsed to string) cannot carry state: ignore.
  }

  private appendItems(target: unknown, items: unknown[], pos: number): void {
    if (Array.isArray(target)) {
      for (const it of items) target.push(it);
    } else if (target instanceof PyObject) {
      (target.listItems ??= []).push(...items);
    } else if (target instanceof Set) {
      for (const it of items) target.add(it);
    } else {
      throw this.err('APPEND target is not a list', pos);
    }
  }

  private setItems(target: unknown, items: unknown[], pos: number): void {
    if (items.length % 2 !== 0) throw this.err('odd number of items for SETITEMS', pos);
    let map: PyDict;
    if (target instanceof Map) map = target;
    else if (target instanceof PyObject) map = target.dictItems ??= new Map();
    else throw this.err('SETITEM target is not a dict', pos);
    for (let i = 0; i < items.length; i += 2) map.set(items[i], items[i + 1]);
  }

  private extension(code: number, pos: number): PyClass {
    const cached = this.extensionCache.get(code);
    if (cached) return cached;
    const entry = this.extensions?.get(code);
    if (!entry) throw this.err(`unregistered extension code ${code}`, pos);
    const cls = new PyClass(entry[0], entry[1]);
    this.extensionCache.set(code, cls);
    return cls;
  }

  private resolvePersistent(pid: unknown): unknown {
    return this.persistentLoad ? this.persistentLoad(pid) : new PyPersistentRef(pid);
  }

  private legacyStr(bytes: Uint8Array): string | Uint8Array {
    switch (this.encoding) {
      case 'bytes': return bytes.slice();
      case 'latin1': return latin1Decode(bytes);
      default: return utf8OrLatin1(bytes);
    }
  }

  // ── stack ──

  private push(v: unknown): void {
    this.stack.push(v);
  }

  private pop(): unknown {
    if (this.stack.length <= this.markBase()) throw this.err('unpickling stack underflow', this.pos - 1);
    return this.stack.pop();
  }

  private top(): unknown {
    if (this.stack.length <= this.markBase()) throw this.err('unpickling stack underflow', this.pos - 1);
    return this.stack[this.stack.length - 1];
  }

  private markBase(): number {
    return this.marks.length ? this.marks[this.marks.length - 1] : 0;
  }

  private popMark(): unknown[] {
    const m = this.marks.pop();
    if (m === undefined) throw this.err('could not find MARK', this.pos - 1);
    return this.stack.splice(m);
  }

  private memoGet(idx: number | bigint, pos: number): unknown {
    const v = typeof idx === 'number' ? this.memo[idx] : undefined;
    if (v === undefined && !(typeof idx === 'number' && idx in this.memo)) {
      throw this.err(`memo value not found at index ${idx}`, pos);
    }
    return v;
  }

  private memoPut(idx: number | bigint, value: unknown, pos: number): void {
    if (typeof idx !== 'number' || idx < 0 || idx > 0xffffffff) throw this.err(`invalid memo index ${idx}`, pos);
    this.memo[idx] = value;
  }

  // ── raw reads ──

  private need(n: number): void {
    if (this.pos + n > this.data.length) throw this.err('pickle data was truncated', this.pos);
  }

  private u8(): number {
    this.need(1);
    return this.data[this.pos++];
  }

  private u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  private i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  private u64(): number {
    this.need(8);
    const lo = this.view.getUint32(this.pos, true);
    const hi = this.view.getUint32(this.pos + 4, true);
    this.pos += 8;
    const v = hi * 0x100000000 + lo;
    if (!Number.isSafeInteger(v)) throw this.err('8-byte length exceeds 2^53', this.pos - 8);
    return v;
  }

  /** Zero-copy view into the input. Callers `.slice()` when they keep it. */
  private bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  private readLine(): string {
    const nl = this.data.indexOf(0x0a, this.pos);
    if (nl < 0) throw this.err('pickle data was truncated (missing newline)', this.pos);
    let line = this.data.subarray(this.pos, nl);
    this.pos = nl + 1;
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1); // tolerate CRLF
    return latin1Decode(line);
  }

  private err(message: string, pos: number): UnpicklingError {
    return new UnpicklingError(message, pos);
  }
}

/** Convenience wrapper: `pickle.loads(data)`. */
export function unpickle(data: Uint8Array | ArrayBuffer, options?: UnpicklerOptions): unknown {
  return new Unpickler(data, options).load();
}

// ─── Small accessors for walking unpickled trees ────────────────────────────

export function isPyObject(v: unknown, qualifiedName?: string): v is PyObject {
  if (!(v instanceof PyObject)) return false;
  return qualifiedName === undefined || v.cls.qualifiedName === qualifiedName;
}

/** Python `str(x)` for the value kinds an unpickled tree can contain. */
export function pyStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return utf8OrLatin1(v);
  return String(v);
}
