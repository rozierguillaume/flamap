#!/usr/bin/env python3
"""Fabrique les icones PNG du site depuis la geometrie de `favicon.svg`.

    python3 make_icons.py

Deux pieges qui expliquent la forme des fichiers produits :

- iOS applique **lui-meme** son masque arrondi sur `apple-touch-icon.png`.
  Une icone deja arrondie livree avec des coins opaques donne l'icone recadree
  sur fond noir qu'on voyait sur l'ecran d'accueil : l'image doit etre carree,
  a fond perdu, sans transparence (iOS composite l'alpha sur du noir).
- Android recadre les icones `maskable` dans un cercle de 80 % du cote. Les
  motifs des icones de manifeste sont donc rentres a 85 % pour tenir dans cette
  zone sure.

Depend de Pillow, comme `make_og.py`, et n'est pas rejoue par les workflows :
les fichiers sont versionnes.
"""
from PIL import Image, ImageDraw

BG = (0x0d, 0x0f, 0x12)
JAUNE, ORANGE, BRIQUE = (0xff, 0xd8, 0x4d), (0xff, 0x6b, 0x1a), (0xb1, 0x34, 0x1f)

VB = 48                    # viewBox de favicon.svg, repere de reference
DX, DY = 6, 7              # translate(...) du groupe de foyers
FOYERS = [(19, 13, 7, JAUNE), (9, 22, 5, ORANGE), (27, 25, 5.2, BRIQUE),
          (8.5, 6.5, 1.6, JAUNE), (25, 3.5, 1.4, BRIQUE), (34, 11.5, 1.5, BRIQUE),
          (2, 29.5, 1.4, ORANGE), (17, 31.5, 1.5, JAUNE), (34, 30, 1.4, ORANGE)]

SS = 4                     # sur-echantillonnage : Pillow ne lisse pas les ellipses

# taille, echelle du motif, fichier
CIBLES = [(180, 1.00, 'apple-touch-icon.png'),
          (192, 0.85, 'icon-192.png'),
          (512, 0.85, 'icon-512.png')]


def dessine(size, scale, path):
    n = size * SS
    img = Image.new('RGB', (n, n), BG)
    d = ImageDraw.Draw(img)
    k = n / VB * scale
    for cx, cy, r, color in FOYERS:
        x = (cx + DX - VB / 2) * k + n / 2
        y = (cy + DY - VB / 2) * k + n / 2
        d.ellipse((x - r * k, y - r * k, x + r * k, y + r * k), fill=color)
    img.resize((size, size), Image.LANCZOS).save(path, optimize=True)
    print(f'{path} — {size}x{size}')


if __name__ == '__main__':
    for cible in CIBLES:
        dessine(*cible)
