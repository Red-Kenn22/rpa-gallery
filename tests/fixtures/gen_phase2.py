"""Builds a small fake Ren'Py game split across scripts.rpa + images.rpa.

usage: python3 gen_phase2.py <outdir> [--media <dir from make_media.py>]
"""
import os, pickle, struct, subprocess, sys, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else os.path.join(HERE, 'out2')
MEDIA_DIR = sys.argv[sys.argv.index('--media') + 1] if '--media' in sys.argv else None

def rpc2(payload, proto):
    data = zlib.compress(pickle.dumps(payload, protocol=proto))
    junk = zlib.compress(b'not a pickle')
    hdr = bytearray(b'RENPY RPC2')
    start1 = 10 + 12 * 3
    hdr += struct.pack('<III', 1, start1, len(data))
    hdr += struct.pack('<III', 2, start1 + len(data), len(junk))
    hdr += struct.pack('<III', 0, 0, 0)
    return bytes(hdr) + data + junk

if '--old' in sys.argv:
    sys.path.insert(0, os.path.join(HERE, 'fakerenpy6'))
    from renpy import ast
    def code(src): return ast.PyCode(source=src, location=('game/old.rpy', 1), mode='exec')
    stmts = [
        ast.Init(linenumber=1, priority=0, block=[ast.Define(linenumber=1, varname='j', store='store', code=code('Character(u"Jun", color="#88f")'))]),
        ast.Label(linenumber=3, name='chapter_two', parameters=None, block=[
            ast.Scene(linenumber=4, imspec=(('bg', 'beach'), [], 'master'), layer='master', atl=None),
            ast.Say(linenumber=5, who='"Eileen"', what='Literal speaker, merged with e', with_=None),
            ast.Say(linenumber=6, who='j', what='Old style line', with_=None),
        ]),
    ]
    sys.stdout.buffer.write(zlib.compress(pickle.dumps(({'version': 6}, stmts), protocol=2)))  # RPYC1
    sys.exit(0)

sys.path.insert(0, os.path.join(HERE, 'fakerenpy8'))
from renpy import ast, atl
from renpy.astsupport import PyExpr
os.makedirs(OUT, exist_ok=True)

def say(line, who, what, translate=True):
    s = ast.Say(line, who=who, what=what, with_=None, interact=True)
    if not translate:
        return s
    return [ast.Translate(line, identifier='id%d' % line, language=None, block=[s]), ast.EndTranslate(line)]

def flat(*items):
    out = []
    for i in items:
        out.extend(i if isinstance(i, list) else [i])
    return out

def imspec(*name):
    return (tuple(name), None, None, [], 'master', None, [])

eileen_atl = atl.RawBlock([atl.RawMultipurpose([(PyExpr('"eileen_happy.png"'), None)], [('xalign', PyExpr('0.5'))])])

script = flat(
    ast.Init(1, priority=0, block=[ast.Define(1, store='store', varname='e', operator='=', code=ast.PyCode('Character("Eileen", color="#c8ffc8", image="eileen")', 1, 'eval'))]),
    ast.Init(2, priority=0, block=[ast.Define(2, store='store', varname='l', operator='=', code=ast.PyCode('Character(_("Lucy"))', 2, 'eval'))]),
    ast.Init(3, priority=0, block=[ast.Define(3, store='store', varname='mc', operator='=', code=ast.PyCode('Character("[player]")', 3, 'eval'))]),
    ast.Init(4, priority=0, block=[ast.Define(4, store='store', varname='ln', operator='=', code=ast.PyCode('Character(kind=l, what_italic=True)', 4, 'eval'))]),
    ast.Init(5, priority=0, block=[ast.Image(5, imgname=('intro',), code=ast.PyCode('Movie(play="video/intro.webm", size=(1920, 1080))', 5, 'eval'), atl=None)]),
    ast.Init(6, priority=0, block=[ast.Image(6, imgname=('cg', 'kiss'), code=ast.PyCode('"cg_kiss.jpg"', 6, 'eval'), atl=None)]),
    ast.Init(7, priority=0, block=[ast.Image(7, imgname=('eileen', 'happy'), atl=eileen_atl)]),
    ast.Init(8, priority=0, block=[ast.Image(8, imgname=('bg', 'night'), code=ast.PyCode('"bg beach"', 8, 'eval'), atl=None)]),
    ast.Init(9, priority=-1, block=[ast.Python(9, hide=False, store='store', code=ast.PyCode('lucy_alt = Character("Lucy Alt")\nrenpy.image("sunset", "images/bg/sunset.webp")', 9))]),
    ast.Label(10, name='start', parameters=None, hide=False, block=flat(
        ast.Scene(11, imspec=imspec('intro'), layer='master'),
        say(12, None, 'Narration line'),
        say(13, 'e', 'Hello {b}there{/b}!'),
        ast.Show(14, imspec=imspec('eileen', 'happy')),
        ast.Jump(15, target='beach', expression=False),
    )),
    ast.Label(20, name='beach', parameters=None, hide=False, block=flat(
        ast.Scene(21, imspec=imspec('bg', 'beach'), layer='master'),
        ast.Show(22, imspec=imspec('lucy', 'smile')),
        say(23, 'l', 'Hi'),
        say(24, 'extend', ' more'),
        ast.Menu(25, items=[
            ('Kiss', 'True', flat(ast.Scene(26, imspec=imspec('cg', 'kiss'), layer='master'), say(27, 'e', 'Mm.'))),
            ('Leave', 'True', [ast.Pass(28)]),
        ]),
        ast.If(29, entries=[('night', [ast.Scene(30, imspec=imspec('bg', 'night'), layer='master')]), ('True', [ast.Pass(31)])]),
        ast.Python(32, hide=False, store='store', code=ast.PyCode('renpy.movie_cutscene("video/ending.webm")', 32)),
        ast.UserStatement(33, line='play movie "video/extra.webm"', parsed=None, block=[], subparses=[]),
        ast.Label(34, name='beach.local', parameters=None, hide=False, block=[
            ast.TranslateSay(35, who='mc', what='Nested label line', with_=None, identifier='x', language=None),
            ast.TranslateSay(36, who='mc', what='Ligne française', with_=None, identifier='x', language='french'),
            ast.Show(37, imspec=imspec('sunset')),
            ast.NewFancyNode(38, block=[ast.Say(39, who='lucy_alt', what='Inside an unknown node', with_=None)]),
        ]),
    )),
    ast.Label(40, name='_private', parameters=None, hide=False, block=say(41, None, 'hidden')),
    ast.Label(42, name='main_menu', parameters=None, hide=False, block=say(43, None, 'engine')),
    ast.Label(44, name='empty_label', parameters=None, hide=False, block=[ast.Pass(45)]),
    ast.Screen(46, screen=None),
)

tl = [ast.TranslateBlock(1, language='french', block=[ast.Label(2, name='start', parameters=None, hide=False, block=say(3, 'e', 'Bonjour'))])]

old_rpyc = subprocess.check_output([sys.executable, '-I', os.path.abspath(__file__), '--old'])

extra_rpy = '''# Source-only script (no .rpyc)
define g = Character("Gina",
                     color="#f80")   # multi-line define
label gallery_extra:
    scene expression "images/cg_kiss.jpg" with dissolve
    e happy "Source-only line with a # not-a-comment"
    g "Gina speaks"
    show g at left  # no image defined for g
    play movie "video/extra.webm"
    menu:
        "What now?"
        "Stay":
            "You stay."
        "Go":
            jump beach
    python:
        x = 1
        renpy.show("cg kiss")
    """Triple
    quoted narration"""
'''
broken_twin_rpy = '''label from_broken_source:
    scene bg beach
    "Recovered from .rpy because the .rpyc is corrupt"
'''

scripts = {
    'script.rpyc': rpc2(({'version': 8030000, 'key': 'abc'}, script), 2),
    'old.rpyc': old_rpyc,
    'extra.rpy': extra_rpy.encode('utf-8'),
    'broken.rpyc': b'RENPY RPC2' + b'\xff' * 40,
    'broken.rpy': broken_twin_rpy.encode('utf-8'),
    'tl/french/script.rpyc': rpc2(({'version': 1}, tl), 5),
}
media = {
    'images/bg beach.png': b'\x89PNG' + b'b' * 100,
    'images/bg/sunset.webp': b'RIFF' + b's' * 80,
    'images/cg_kiss.jpg': b'\xff\xd8' + b'k' * 90,
    'images/sprites/eileen_happy.png': b'\x89PNG' + b'e' * 70,
    'images/lucy smile.png': b'\x89PNG' + b'l' * 60,
    'video/intro.webm': b'\x1aE\xdf\xa3' + b'i' * 300,
    'video/ending.webm': b'\x1aE\xdf\xa3' + b'n' * 200,
    'video/extra.webm': b'\x1aE\xdf\xa3' + b'x' * 150,
    'audio/theme.ogg': b'OggS' + b'a' * 50,
}

if MEDIA_DIR:  # swap the placeholder bytes for real files (see make_media.py)
    for name in media:
        with open(os.path.join(MEDIA_DIR, name), 'rb') as fh:
            media[name] = fh.read()

def write_rpa(path, files, key=0x1234abcd):
    with open(path, 'wb') as f:
        f.write(b'\0' * 34)
        index = {}
        for name, data in files.items():
            o = f.tell(); f.write(data)
            index[name] = [(o ^ key, len(data) ^ key, b'')]
        io = f.tell()
        f.write(zlib.compress(pickle.dumps(index, protocol=2)))
        f.seek(0)
        f.write(b'RPA-3.0 %016x %08x\n' % (io, key))

write_rpa(os.path.join(OUT, 'scripts.rpa'), scripts)
write_rpa(os.path.join(OUT, 'images.rpa'), media, key=0x0f0f0f0f)
with open(os.path.join(OUT, 'media.json'), 'w') as fh:
    import json
    json.dump({k: v.hex() for k, v in media.items()}, fh)
print('phase 2 fixtures written to', OUT)
