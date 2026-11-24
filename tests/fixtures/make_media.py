"""Creates real images/videos (same names as gen_phase2.py) for UI testing.

usage: python3 make_media.py <outdir>      (needs Pillow + ffmpeg)
"""
import os, subprocess, sys
from PIL import Image, ImageDraw

OUT = sys.argv[1]
def path(p):
    full = os.path.join(OUT, p); os.makedirs(os.path.dirname(full), exist_ok=True); return full

def scene_image(p, top, bottom, label, size=(1280, 720), fmt=None):
    w, h = size
    img = Image.new('RGB', size)
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] * (1 - t) + bottom[i] * t) for i in range(3)))
    d.ellipse([w * 0.62, h * 0.12, w * 0.82, h * 0.48], fill=(255, 236, 180))
    d.rectangle([0, h * 0.72, w, h], fill=tuple(int(c * 0.55) for c in bottom))
    d.text((40, 40), label, fill=(255, 255, 255), font_size=64)
    img.save(path(p), fmt)

scene_image('images/bg beach.png', (90, 170, 230), (250, 210, 150), 'bg beach')
scene_image('images/bg/sunset.webp', (60, 30, 90), (250, 120, 80), 'sunset', fmt='WEBP')
scene_image('images/cg_kiss.jpg', (120, 40, 80), (240, 150, 170), 'cg kiss', fmt='JPEG')
scene_image('images/sprites/eileen_happy.png', (30, 30, 30), (60, 60, 60), 'eileen', size=(400, 800))
scene_image('images/lucy smile.png', (30, 30, 30), (60, 60, 60), 'lucy', size=(400, 800))

def video(p, color, label):
    subprocess.run([
        'ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'testsrc2=size=640x360:rate=24:duration=3',
        '-vf', f"drawbox=x=0:y=0:w=iw:h=ih:color={color}@0.35:t=fill,drawtext=text='{label}':x=30:y=30:fontsize=48:fontcolor=white",
        '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', path(p)], check=True)

video('video/intro.webm', 'blue', 'INTRO')
video('video/ending.webm', 'red', 'ENDING')
video('video/extra.webm', 'green', 'EXTRA')
def tone(p, freq, secs):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={freq}:duration={secs}', '-c:a', 'libvorbis', path(p)], check=True)

tone('audio/theme.ogg', 440, 4)
tone('audio/night.ogg', 330, 4)
tone('voice/e001.ogg', 660, 3)
print('media written to', OUT)
