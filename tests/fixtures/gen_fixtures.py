"""Generates pickle + RPA fixtures for tests/verify-phase1.ts.

usage: python3 gen_fixtures.py <outdir>
"""
import base64, collections, json, os, pickle, struct, sys, zlib, math

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'fakerenpy'))
from renpy import ast, revertable  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)

# ── canonical JSON encoding of expected values ──────────────────────────────
def enc(v):
    if v is None or isinstance(v, bool):
        return v
    if isinstance(v, ast.PyExpr):
        return str(v)
    if isinstance(v, int):
        return {'$i': str(v)}
    if isinstance(v, float):
        if math.isnan(v): return {'$f': 'nan'}
        if math.isinf(v): return {'$f': 'inf' if v > 0 else '-inf'}
        return {'$f': v}
    if isinstance(v, str):
        return v
    if isinstance(v, (bytes, bytearray)):
        return {'$b': v.hex()}
    if isinstance(v, tuple):
        return {'$t': [enc(x) for x in v]}
    if isinstance(v, list):
        return {'$l': [enc(x) for x in v]}
    if isinstance(v, dict):
        return {'$d': [[enc(k), enc(x)] for k, x in v.items()]}
    if isinstance(v, (set, frozenset)):
        return {'$set': [enc(x) for x in v]}
    # generic object
    cls = type(v)
    attrs = {}
    for c in cls.__mro__:
        for s in getattr(c, '__slots__', ()):
            if hasattr(v, s):
                attrs[s] = enc(getattr(v, s))
    if hasattr(v, '__dict__'):
        for k, x in v.__dict__.items():
            attrs[k] = enc(x)
    out = {'$o': f'{cls.__module__}.{cls.__name__}', 'attrs': attrs}
    if isinstance(v, ast.PyCode):
        out = {'$o': 'renpy.ast.PyCode', 'state': enc(v.__getstate__())}
    return out

def build_ast():
    loc = ('script.rpy', 10)
    lbl = ast.Label(loc); lbl.name = 'chapter1_beach'; lbl.parameters = None; lbl.hide = False
    sc = ast.Scene(loc); sc.imspec = (('bg', 'beach'), None, None, [], None, None, []); sc.layer = 'master'; sc.atl = None
    say = ast.Say(loc); say.who = 'e'; say.what = 'Héllo "world"\n— ✓ 🎉'; say.with_ = None; say.attributes = None
    say2 = ast.Say(('script.rpy', 12)); say2.who = None; say2.what = 'narration'; say2.with_ = None; say2.attributes = ('happy',)
    lbl.block = revertable.RevertableList([sc, say, say2])
    for a, b in zip(lbl.block, lbl.block[1:]):
        a.next = b
    say2.next = None
    lbl.next = sc
    img = ast.Image(loc); img.imgname = ('bg', 'beach'); img.code = ast.PyCode(ast.PyExpr('"images/beach.png"', 'script.rpy', 3), loc, 'eval'); img.atl = None
    d = ast.Define(loc); d.varname = 'e'; d.code = ast.PyCode(ast.PyExpr('Character("Eileen", color="#c8ffc8")', 'script.rpy', 1), loc, 'eval'); d.store = 'store'; d.operator = '='; d.index = None
    data = {'version': 5003000, 'key': 'unlocked', 'meta': revertable.RevertableDict({'a': 1}),
            'tags': revertable.RevertableSet({'x'})}
    return (data, [d, img, lbl, ast.DictNode(kind='old', lines=[1, 2])])

values = {
    'none_bools': [None, True, False],
    'ints': [0, 1, -1, 255, 256, 65535, 65536, 2**31 - 1, -2**31, 2**31, 2**32 + 5, -(2**40),
             2**53 - 1, 2**53 + 1, -(2**63), 2**100, -(2**100) + 7],
    'floats': [0.0, -0.0, 1.5, -2.25, 1e300, 3.141592653589793, float('inf'), float('-inf'), float('nan')],
    'strings': ['', 'ascii', 'tab\tnew\nline\\back\rslash\x00nul', 'quote\'s "dq"', 'ünïcødé ✓ 日本語 🎉',
                '\\u0041 not an escape', 'x' * 300],
    'bytes': [b'', b'\x00\x01\xff', bytes(range(256)), bytearray(b'abc')],
    'containers': {'list': [1, [2, [3, []]]], 'tuple0': (), 'tuple1': (1,), 'tuple2': (1, 2),
                   'tuple3': (1, 2, 3), 'tuple4': (1, 2, 3, 4), 'nested': {'k': {'j': (None,)}},
                   1: 'int key', (1, 2): 'tuple key', 'set': {1, 2, 3}, 'fs': frozenset({'a'}),
                   'od': collections.OrderedDict([('z', 1), ('a', 2)]),
                   'dd': collections.defaultdict(list, {'q': [1]}),
                   'big': list(range(1200))},
    'renpy_ast': build_ast(),
    'rpa_style_index': {'images/bg beach.png': [(0x1234 ^ 0xDEADBEEF, 999 ^ 0xDEADBEEF, b'')],
                        'video/op.webm': [(2**33 ^ 0xDEADBEEF, 5 ^ 0xDEADBEEF, b'')]},
}

fixtures = []
for name, v in values.items():
    for proto in range(0, 6):
        try:
            data = pickle.dumps(v, protocol=proto)
        except Exception as e:  # e.g. slots objects at protocol 0/1 on some Pythons
            print(f'skip {name} p{proto}: {e}')
            continue
        fixtures.append({'name': name, 'proto': proto, 'b64': base64.b64encode(data).decode(), 'expected': enc(v)})

# Hand-written Python-2 style streams (py3 can't emit BINSTRING / 'S' strings).
py2_streams = {
    'py2_short_binstring': (b'\x80\x02U\x05hello.', {'$b': b'hello'.hex()}),
    'py2_binstring': (b'\x80\x02T\x03\x00\x00\x00\xff\x00a.', {'$b': 'ff0061'}),
    'py2_proto0_string': (b"S'a\\nb\\x00\\'q\\\\'\np0\n.", {'$b': b"a\nb\x00'q\\".hex()}),
    'py2_proto0_long': (b'L123456789012345678901234567890L\n.', {'$i': '123456789012345678901234567890'}),
    'py2_proto0_int_bools': (b'(I01\nI00\nI-42\nt.', {'$t': [True, False, {'$i': '-42'}]}),
    'py2_proto0_unicode': (b'V\\u00e9t\\u00e9 \\U0001f389 \\\\u0041\np0\n.', 'été 🎉 \\\\u0041'),
    'py2_builtin_set': (b'c__builtin__\nset\np0\n((lp1\nI1\naI2\natp2\nRp3\n.', {'$set': [{'$i': '1'}, {'$i': '2'}]}),
    'py2_inst_opcode': (b'(S\'x\'\nS\'y\'\nirenpy.ast\nNode\np0\n(dp1\nS\'name\'\np2\nS\'lbl\'\np3\nsb.',
                        {'$o': 'renpy.ast.Node', 'attrs': {'name': 'lbl'}}),
    'py2_obj_and_dup_pop': (b'(crenpy.ast\nScene\no2(I5\n10.', {'$o': 'renpy.ast.Scene', 'attrs': {}}),
    'ext1_registry': (b'\x80\x02\x82\x07)\x81.', {'$o': 'renpy.ast.Say', 'attrs': {}}),
    'persid': (b'\x80\x02U\x03abcQ.', {'$persid': {'$b': b'abc'.hex()}}),
}
for name, (data, expected) in py2_streams.items():
    fixtures.append({'name': name, 'proto': -2, 'b64': base64.b64encode(data).decode(), 'expected': expected})

# Shared / recursive references (checked by identity in JS).
shared = [1, 2]
rec = []
rec.append(rec)
for proto in range(6):
    fixtures.append({'name': 'shared_ref', 'proto': proto, 'b64': base64.b64encode(pickle.dumps([shared, shared], protocol=proto)).decode(), 'expected': None})
    fixtures.append({'name': 'recursive_list', 'proto': proto, 'b64': base64.b64encode(pickle.dumps(rec, protocol=proto)).decode(), 'expected': None})

# Protocol 5 out-of-band buffer.
pb = pickle.PickleBuffer(b'oob-data')
oob_bufs = []
oob = pickle.dumps([pb], protocol=5, buffer_callback=oob_bufs.append)
fixtures.append({'name': 'oob_buffer', 'proto': 5, 'b64': base64.b64encode(oob).decode(), 'expected': {'$l': [{'$b': b'oob-data'.hex()}]},
                 'buffers': [base64.b64encode(bytes(b.raw())).decode() for b in oob_bufs]})

with open(os.path.join(OUT, 'pickles.json'), 'w') as f:
    json.dump(fixtures, f)

# ── RPA archives ────────────────────────────────────────────────────────────
FILES = {
    'images/bg beach.png': b'\x89PNG\r\n\x1a\n' + os.urandom(3000),
    'images/eileen happy.webp': b'RIFF' + os.urandom(1500),
    'video/op.webm': b'\x1aE\xdf\xa3' + os.urandom(20000),
    'script.rpyc': b'RENPY RPC2' + os.urandom(500),
    'unicode/日本語 ✓.png': os.urandom(77),
    'empty.txt': b'',
}

def py2_index_pickle(index):
    """Emit what Python 2's cPickle protocol 2 would: SHORT_BINSTRING names/prefixes, LONG1 for big ints."""
    out = bytearray(b'\x80\x02}q\x00')
    memo = 1
    def emit_int(n):
        if 0 <= n < 256: return b'K' + bytes([n])
        if 0 <= n < 65536: return b'M' + struct.pack('<H', n)
        if -2**31 <= n < 2**31: return b'J' + struct.pack('<i', n)
        nbytes = (n.bit_length() + 8) // 8
        return b'\x8a' + bytes([nbytes]) + n.to_bytes(nbytes, 'little', signed=True)
    for name, segs in index.items():
        nb = name.encode('utf-8')
        out += b'U' + bytes([len(nb)]) + nb if len(nb) < 256 else b'T' + struct.pack('<i', len(nb)) + nb
        out += b'q' + bytes([memo % 256]); memo += 1
        out += b']q' + bytes([memo % 256]); memo += 1
        out += b'('
        for seg in segs:
            off, ln = seg[0], seg[1]
            out += emit_int(off) + emit_int(ln)
            if len(seg) > 2:
                out += b'U' + bytes([len(seg[2])]) + seg[2] + b'\x87'
            else:
                out += b'\x86'
        out += b'es'
    out += b'.'
    return bytes(out)

def write_archive(path, version, key, files, proto=2, pad_to=None, prefix_for=None, split=None, py2=False):
    with open(path, 'wb') as f:
        header_len = 34 if version in ('RPA-3.0',) else (25 if version == 'RPA-2.0' else 64)
        f.write(b'\0' * header_len)
        if pad_to:  # sparse gap so offsets go past 4 GB
            f.seek(pad_to)
        index = {}
        for name, data in files.items():
            pre = b''
            if prefix_for and name in prefix_for:
                pre, data_stored = data[:prefix_for[name]], data[prefix_for[name]:]
            else:
                data_stored = data
            if split and name in split:
                a, b = data[:split[name]], data[split[name]:]
                o1 = f.tell(); f.write(a); f.write(b'PADDING!'); o2 = f.tell(); f.write(b)
                segs = [(o1, len(a)), (o2, len(b))]
            else:
                o = f.tell(); f.write(data_stored)
                segs = [(o, len(data), pre)] if pre or not py2 else [(o, len(data))]
            if key is not None:
                segs = [tuple([s[0] ^ key, s[1] ^ key] + list(s[2:])) for s in segs]
            index[name] = segs
        index_off = f.tell()
        raw = py2_index_pickle(index) if py2 else pickle.dumps(index, protocol=proto)
        f.write(zlib.compress(raw))
        f.seek(0)
        if version == 'RPA-3.0':
            hdr = b'RPA-3.0 %016x %08x\n' % (index_off, key)
        elif version == 'RPA-2.0':
            hdr = b'RPA-2.0 %016x\n' % index_off
        elif version == 'RPA-3.2':
            hdr = b'RPA-3.2 %016x %08x %08x\n' % (index_off, 0, key)
        elif version == 'ALT-1.0':
            hdr = b'ALT-1.0 %08x %016x\n' % (key ^ 0xDABE8DF0, index_off)
        f.write(hdr.ljust(header_len, b'\0') if len(hdr) <= header_len else hdr)
        assert len(hdr) <= header_len, (version, len(hdr))

archives = []
def add(fname, **kw):
    path = os.path.join(OUT, fname)
    write_archive(path, **kw)
    archives.append({'file': fname, 'version': kw['version']})

add('v3_p2.rpa', version='RPA-3.0', key=0x42424242, files=FILES, proto=2)  # bytes → _codecs.encode REDUCE
add('v3_p4.rpa', version='RPA-3.0', key=0x7fabcdef, files=FILES, proto=4)
add('v3_p0.rpa', version='RPA-3.0', key=0x0badf00d, files=FILES, proto=0)
add('v2.rpa', version='RPA-2.0', key=None, files=FILES, proto=2)
add('v32.rpa', version='RPA-3.2', key=0x13572468, files=FILES, proto=3)
add('alt.rpa', version='ALT-1.0', key=0x24681357, files=FILES, proto=2)
add('py2_prefix_split.rpa', version='RPA-3.0', key=0x5a5a5a5a, files=FILES, py2=True,
    prefix_for={'images/bg beach.png': 8}, split={'video/op.webm': 1234})
add('huge_sparse.rpa', version='RPA-3.0', key=0xcafebabe, files=FILES, proto=2, pad_to=5 * 2**30 + 17)

# RPA-1.0 (.rpi + headerless data file)
with open(os.path.join(OUT, 'v1.rpa'), 'wb') as f:
    idx = {}
    for name, data in FILES.items():
        idx[name] = [(f.tell(), len(data))]
        f.write(data)
with open(os.path.join(OUT, 'v1.rpi'), 'wb') as f:
    f.write(zlib.compress(pickle.dumps(idx, protocol=2)))

with open(os.path.join(OUT, 'archives.json'), 'w') as f:
    json.dump({'archives': archives, 'files': {k: v.hex() for k, v in FILES.items()}}, f)

print(f'wrote {len(fixtures)} pickle fixtures and {len(archives) + 1} archives to {OUT}')
