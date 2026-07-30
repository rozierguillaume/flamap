#!/usr/bin/env python3
"""Fabrique og.png, l'image d'apercu des liens (reseaux sociaux, messageries).

Rejoue hors navigateur ce que fait `index.html` : fond ortho IGN (Sentinel-2 en
secours), polygones EFFIS, foyers FIRMS coloriies par anciennete. Les robots
d'indexation et les messageries ne rendent pas le WebGL, il leur faut un PNG.

    python3 make_og.py            # cadre par defaut : le feu de Gironde
    python3 make_og.py -1.32 44.66 -0.70 45.02

Depend de Pillow (`pip install pillow`), la seule dependance du depot, et
n'est pas rejoue par le workflow : l'image est versionnee.
"""
import json, math, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630           # format attendu par OpenGraph / Twitter
Z = 12                     # zoom des tuiles ; 12 couvre le feu en ~1700 px
TILE = 256
DEFAULT_BBOX = (-1.32, 44.66, -0.70, 45.02)   # Le Porge / Lege-Cap-Ferret

ORTHO = ('https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
         '&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM'
         '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg')
S2 = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg'

BURNT, BURNT_EDGE = (0x2a, 0x23, 0x20), (0x6b, 0x5a, 0x4e)
INK, DIM = (0xe8, 0xe6, 0xe3), (0xa8, 0xa2, 0x9c)
H_ = 3600
RAMP = [(6 * H_, (0xff, 0xd8, 0x4d)), (24 * H_, (0xff, 0x6b, 0x1a)),
        (72 * H_, (0xb1, 0x34, 0x1f)), (math.inf, (0x7d, 0x3b, 0x28))]

FONTS = '/System/Library/Fonts/Supplemental/'


def merc(lon, lat, z):
    """Coordonnees pixel Web Mercator, origine en haut a gauche du planisphere."""
    n = TILE * 2 ** z
    s = math.sin(math.radians(lat))
    return (lon + 180) / 360 * n, (.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n


def fetch(url, tries=3):
    """Une tuile, ou None hors couverture. La Geoplateforme repond parfois 5xx
    sous charge : un trou dans la mosaique se voit tout de suite, on reessaie."""
    req = urllib.request.Request(url, headers={'User-Agent': 'flamap/og'})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return Image.open(BytesIO(r.read())).convert('RGB')
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None          # hors emprise : inutile d'insister
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(.5 * (i + 1))
    return None


def basemap(x0, y0, w, h):
    """Mosaique des tuiles couvrant le rectangle demande, en pixels du zoom Z."""
    canvas = Image.new('RGB', (w, h), (13, 15, 18))
    tiles = [(tx, ty)
             for tx in range(int(x0) // TILE, int(x0 + w) // TILE + 1)
             for ty in range(int(y0) // TILE, int(y0 + h) // TILE + 1)]

    def one(t):
        tx, ty = t
        u = {'z': Z, 'x': tx, 'y': ty}
        return t, fetch(ORTHO.format(**u)) or fetch(S2.format(**u))

    with ThreadPoolExecutor(16) as pool:
        for (tx, ty), img in pool.map(one, tiles):
            if img:
                canvas.paste(img, (tx * TILE - int(x0), ty * TILE - int(y0)))
    return canvas


def load(name):
    with open(f'data/{name}.geojson') as f:
        return json.load(f)['features']


def rings(geom):
    """Anneaux d'un Polygon ou MultiPolygon, a plat."""
    cs = geom['coordinates']
    return cs if geom['type'] == 'Polygon' else [r for p in cs for r in p]


def main():
    bbox = tuple(map(float, sys.argv[1:5])) if len(sys.argv) > 4 else DEFAULT_BBOX
    west, south, east, north = bbox

    # Cadrage : on centre sur la bbox et on prend la fenetre au bon format.
    x1, y1 = merc(west, north, Z)
    x2, y2 = merc(east, south, Z)
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    scale = min(W / (x2 - x1), H / (y2 - y1))     # <= 1 : on reduira la mosaique
    vw, vh = W / scale, H / scale
    x0, y0 = cx - vw / 2, cy - vh / 2

    img = basemap(x0, y0, math.ceil(vw), math.ceil(vh))
    d = ImageDraw.Draw(img, 'RGBA')

    px = lambda lon, lat: tuple(a - b for a, b in zip(merc(lon, lat, Z), (x0, y0)))

    dated, hs = load('burnt_dated'), load('hotspots')
    for f in dated:
        for ring in rings(f['geometry']):
            d.polygon([px(*c[:2]) for c in ring], fill=BURNT + (200,),
                      outline=BURNT_EDGE + (240,), width=2)

    # Anciennete comptee depuis la derniere detection, comme le dernier cran
    # du curseur : c'est l'etat que la carte affiche a l'ouverture.
    now = max(f['properties']['ts'] for f in hs)
    r = 4 / scale        # 4 px une fois la mosaique reduite au format final
    for f in sorted(hs, key=lambda f: f['properties']['ts']):
        age = now - f['properties']['ts']
        if age > 5 * 86400:
            continue
        color = next(c for lim, c in RAMP if age < lim)
        x, y = px(*f['geometry']['coordinates'][:2])
        if -r <= x <= vw + r and -r <= y <= vh + r:
            d.ellipse((x - r, y - r, x + r, y + r), fill=color + (235,))

    img = img.resize((W, H), Image.LANCZOS).convert('RGBA')

    # Bandeau degrade : le texte doit rester lisible quelle que soit la tuile.
    veil = Image.new('RGBA', (1, H))
    for y in range(H):
        t = max(0.0, (y - H * .50) / (H * .50))
        veil.putpixel((0, y), (13, 15, 18, int(240 * t ** 1.5)))
    img.alpha_composite(veil.resize((W, H)))

    d = ImageDraw.Draw(img)
    bold = ImageFont.truetype(FONTS + 'Arial Bold.ttf', 62)
    reg = ImageFont.truetype(FONTS + 'Arial.ttf', 27)
    small = ImageFont.truetype(FONTS + 'Arial.ttf', 20)

    d.text((56, H - 172), 'Fla', font=bold, fill=(0xff, 0x6b, 0x1a))
    d.text((56 + d.textlength('Fla', font=bold), H - 172), 'map', font=bold, fill=INK)
    d.text((56, H - 90), 'Les incendies vus par satellite, en quasi temps réel',
           font=reg, fill=INK)
    d.text((56, H - 48), 'foyers actifs NASA FIRMS · surfaces brûlées Copernicus EFFIS',
           font=small, fill=DIM)

    img.convert('RGB').save('og.png', optimize=True)
    print(f'og.png — {W}x{H}, {len(hs)} foyers, {len(dated)} polygones')


if __name__ == '__main__':
    main()
