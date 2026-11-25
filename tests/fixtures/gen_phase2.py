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
from renpy.sl2 import slast
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
    # ── Split scene: menu branches into labels that rejoin, then an explicit continuation ──
    ast.Init(47, priority=0, block=[ast.Python(47, hide=False, store='store', code=ast.PyCode('gui.init(1280, 720)', 47))]),
    ast.Init(48, priority=0, block=[ast.Define(48, store='store.audio', varname='theme', operator='=', code=ast.PyCode('"audio/theme.ogg"', 48, 'eval'))]),
    ast.Label(50, name='w1_date', parameters=None, hide=False, block=flat(
        ast.Scene(51, imspec=imspec('bg', 'beach'), layer='master'),
        ast.Show(52, imspec=(('eileen', 'happy'), None, None, [PyExpr('left')], 'master', None, [])),
        ast.UserStatement(52, line='play music theme fadein 1.0', parsed=None, block=[], subparses=[]),
        ast.UserStatement(52, line='voice "voice/e001.ogg"', parsed=None, block=[], subparses=[]),
        say(53, 'e', 'Where should we go?'),
        ast.Call(54, label='common_phone', expression=False),
        ast.Menu(55, items=[
            ('Park', 'True', [ast.Jump(56, target='w1_date_park', expression=False)]),
            ('Cafe', 'affection >= 5', [ast.Jump(57, target='w1_date_cafe', expression=False)]),
            ('Go home', 'True', [ast.Jump(58, target='w1_night', expression=False)]),
        ]),
    )),
    ast.Label(60, name='w1_date_park', parameters=None, hide=False, block=flat(
        ast.Python(60, hide=False, store='store', code=ast.PyCode('eileen_love += 1', 60)),
        say(61, 'e', 'The park is lovely.'), ast.Jump(62, target='w1_date_end', expression=False))),
    ast.Label(63, name='w1_date_cafe', parameters=None, hide=False, block=flat(
        ast.Python(63, hide=False, store='store', code=ast.PyCode('lucy_love += 2\nmet_cafe = True\nadd_points("lucy", 1)', 63)),
        ast.Hide(64, imspec=(('eileen',), None, None, [], 'master', None, [])),
        ast.Scene(65, imspec=imspec('cg', 'kiss'), layer='master'),
        ast.UserStatement(65, line='play sound "audio/theme.ogg"', parsed=None, block=[], subparses=[]),
        ast.UserStatement(66, line='pause', parsed=None, block=[], subparses=[]),
        ast.Jump(67, target='w1_date_end', expression=False))),
    ast.Label(68, name='w1_date_end', parameters=None, hide=False, block=flat(
        say(69, None, 'Later...'), ast.Jump(70, target='w1_date_part2', expression=False))),
    ast.Label(71, name='w1_date_part2', parameters=None, hide=False, block=flat(
        ast.UserStatement(71, line='stop music fadeout 2.0', parsed=None, block=[], subparses=[]),
        say(72, 'e', 'What a day.'), ast.Jump(73, target='w1_night', expression=False))),
    ast.Label(74, name='w1_night', parameters=None, hide=False, block=flat(
        ast.Scene(75, imspec=imspec('sunset'), layer='master'),
        ast.Python(75, hide=False, store='store', code=ast.PyCode('renpy.music.play("audio/night.ogg", channel="music", loop=True)', 75)),
        ast.Call(76, label='common_phone', expression=False),
        ast.If(77, entries=[('eileen_love >= 1', say(77, 'l', 'You seem happy.')), ('True', say(77, 'l', 'Goodnight.'))]))),
    ast.Label(78, name='common_phone', parameters=None, hide=False, block=flat(
        say(79, None, 'Your phone buzzes.'), ast.Return(80, expression=None))),
    ast.Label(40, name='_private', parameters=None, hide=False, block=say(41, None, 'hidden')),
    ast.Label(42, name='main_menu', parameters=None, hide=False, block=say(43, None, 'engine')),
    ast.Label(44, name='empty_label', parameters=None, hide=False, block=[ast.Pass(45)]),
    ast.Screen(46, screen=None),
    ast.Screen(90, screen=slast.SLScreen(name='replay_gallery', parameters=None, keyword=[('tag', PyExpr('"menu"'))], children=[
        slast.SLDisplayable(displayable='textbutton', positional=[PyExpr('"Beach date"')], keyword=[('action', PyExpr('Replay("w1_date", scope={"player": "Sam"})'))], children=[]),
        slast.SLDisplayable(displayable='imagebutton', positional=[], keyword=[('idle', PyExpr('"gallery/lucy.png"')), ('action', PyExpr('Replay("beach")'))], children=[]),
    ])),
    ast.Init(91, priority=0, block=[ast.Python(91, hide=False, store='store', code=ast.PyCode('g = Gallery()\ng.button("beach")\ng.unlock_image("bg beach")', 91))]),
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
    'images/gallery/lucy.png': b'\x89PNG' + b'L' * 55,
    'video/intro.webm': b'\x1aE\xdf\xa3' + b'i' * 300,
    'video/ending.webm': b'\x1aE\xdf\xa3' + b'n' * 200,
    'video/extra.webm': b'\x1aE\xdf\xa3' + b'x' * 150,
    'audio/theme.ogg': b'OggS' + b'a' * 50,
    'audio/night.ogg': b'OggS' + b'n' * 40,
    'voice/e001.ogg': b'OggS' + b'v' * 30,
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
# ── Android APK, laid out like Ren'Py's packager: assets/x-game/ with x- on every component ──
import io, zipfile
def x_path(p):
    return 'assets/x-game/' + '/'.join('x-' + part for part in p.split('/'))

bonus_png = b'\x89PNG' + b'B' * 64
gui_png = b'\x89PNG' + b'G' * 4000          # stored deflated inside the APK
if MEDIA_DIR:  # real decodable images for UI tests
    bonus_png = media['images/bg beach.png']
    gui_png = media['images/lucy smile.png']
nested = io.BytesIO()
key = 0x0badcafe
nested.write(b'\0' * 34)
o = nested.tell(); nested.write(bonus_png)
idx_off = nested.tell()
nested.write(zlib.compress(pickle.dumps({'images/bonus.png': [(o ^ key, len(bonus_png) ^ key, b'')]}, protocol=2)))
nested_bytes = bytearray(nested.getvalue())
nested_bytes[:34] = (b'RPA-3.0 %016x %08x\n' % (idx_off, key))
apk_only_rpy = '''label apk_bonus:
    scene expression "images/bonus.png"
    show expression "images/gui_deflated.png" at right
    "From the APK"
'''
with zipfile.ZipFile(os.path.join(OUT, 'game.apk'), 'w') as z:
    z.writestr('AndroidManifest.xml', b'\x03\x00' * 50, zipfile.ZIP_DEFLATED)
    z.writestr('classes.dex', b'dex\n035' * 20, zipfile.ZIP_DEFLATED)
    z.writestr('assets/x-renpy/x-common/x-00start.rpyc', b'engine file, must be ignored', zipfile.ZIP_DEFLATED)
    for name, data in scripts.items():
        z.writestr(x_path(name), data, zipfile.ZIP_DEFLATED)
    z.writestr(x_path('apkonly.rpy'), apk_only_rpy.encode(), zipfile.ZIP_DEFLATED)
    z.writestr(x_path('extras.rpa'), bytes(nested_bytes), zipfile.ZIP_STORED)
    z.writestr(x_path('images/gui_deflated.png'), gui_png, zipfile.ZIP_DEFLATED)
media_apk = {'images/bonus.png': bonus_png.hex(), 'images/gui_deflated.png': gui_png.hex()}

with open(os.path.join(OUT, 'media.json'), 'w') as fh:
    import json
    json.dump({**{k: v.hex() for k, v in media.items()}, **media_apk}, fh)
print('phase 2 fixtures written to', OUT)
