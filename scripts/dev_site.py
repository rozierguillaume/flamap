#!/usr/bin/env python3
"""Rejoue en local ce que font les workflows de publication.

Les trois workflows ne contiennent presque aucune logique propre à GitHub :
hormis `checkout`, `upload-pages-artifact` et `deploy-pages`, chaque étape est
un appel à un script du dépôt. Ce fichier enchaîne exactement les mêmes appels,
dans le même ordre, et affiche chaque commande avant de la lancer — ce qui se
vérifie ici est donc bien ce qui tournera là-bas.

    python3 scripts/dev_site.py front     # front local + données publiées
    python3 scripts/dev_site.py collect --regions fr
    python3 scripts/dev_site.py serve

`front` est la boucle courte, celle du travail d'interface : quelques secondes,
aucune source interrogée, et l'artefact obtenu est celui qu'`update-front-deploy`
publierait. `collect` est la boucle longue : elle interroge les vraies sources,
écrit hors de `data/` et vérifie l'export avant de l'assembler.

Ce script ne déploie rien et ne parle ni à l'archive ni à Telegram.
"""

from __future__ import annotations

import argparse
import pathlib
import shutil
import subprocess
import sys
import time


ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "_dev"
DEFAULT_DATA = ROOT / "data-dev"
LIVE_SITE = "https://flamap.fr"


def run(*command: object) -> None:
    """Lance une étape en affichant sa commande, comme le journal du workflow."""
    printable = [str(part) for part in command]
    print(f"\n$ {' '.join(printable)}", flush=True)
    started = time.monotonic()
    result = subprocess.run([sys.executable, *printable[1:]], cwd=ROOT)
    if result.returncode:
        raise SystemExit(f"étape en échec ({result.returncode}) : {printable[1]}")
    print(f"  ✓ {time.monotonic() - started:.1f} s", flush=True)


def fresh(directory: pathlib.Path) -> pathlib.Path:
    """Un artefact Pages remplace le précédent en entier : on fait pareil.

    Assembler par-dessus un ancien répertoire masquerait justement le défaut
    qu'on cherche — un fichier qu'un assemblage a cessé d'emporter y resterait
    présent, et le site paraîtrait complet à tort.
    """
    if directory.exists():
        shutil.rmtree(directory)
    return directory


def build_front(output: pathlib.Path, site: str) -> None:
    run("python3", "scripts/download_live_artifact.py",
        "--mode", "front", "--site", site, "--output", output)
    run("python3", "scripts/assemble_site.py", "front", "--output", output)
    run("python3", "scripts/validate_export.py", "front", output)


def build_collect(output: pathlib.Path, data: pathlib.Path,
                  regions: str | None, bbox: list[str],
                  history: str | None) -> None:
    data.mkdir(parents=True, exist_ok=True)
    if history:
        # L'équivalent de l'étape « Reprendre l'historique FIRMS publié » :
        # sans elle la fenêtre s'arrête aux sept jours des flux FIRMS.
        run("python3", "scripts/download_live_artifact.py",
            "--mode", "history", "--site", history, "--data", data,
            "--prev", ROOT / "prev-dev")
    collect = ["python3", "fetch_fires.py", "--out", data]
    if regions:
        collect += ["--regions", regions]
    collect += bbox
    run(*collect)
    run("python3", "scripts/validate_export.py", "fire-data", data)
    run("python3", "scripts/assemble_site.py", "fire",
        "--data", data, "--output", output)
    run("python3", "scripts/validate_export.py", "size", output)


def serve(output: pathlib.Path, port: int) -> None:
    if not (output / "index.html").is_file():
        raise SystemExit(
            f"{output} n'est pas un artefact assemblé : lancer d'abord "
            "`dev_site.py front` ou `dev_site.py collect`"
        )
    print(f"\nArtefact prêt dans {output}. Ctrl-C pour arrêter le serveur.")
    run("python3", "scripts/serve_no_cache.py",
        "--root", output, "--port", port)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=("front", "collect", "serve"))
    parser.add_argument("bbox", nargs="*",
                        help="bbox passée au collecteur : west south east north")
    parser.add_argument("--regions", help="sous-ensemble de régions à collecter")
    parser.add_argument("--data", type=pathlib.Path, default=DEFAULT_DATA,
                        help="répertoire de collecte (défaut : data-dev)")
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT,
                        help="artefact assemblé (défaut : _dev)")
    parser.add_argument("--site", default=LIVE_SITE,
                        help="site publié servant de source aux données reprises")
    parser.add_argument("--history", nargs="?", const=LIVE_SITE, default=None,
                        help="reprendre l'historique FIRMS publié avant la collecte")
    parser.add_argument("--port", type=int, default=8777)
    parser.add_argument("--no-serve", action="store_true",
                        help="assembler sans servir")
    args = parser.parse_args()

    if args.mode == "serve":
        return serve(args.output, args.port)

    output = fresh(args.output)
    if args.mode == "front":
        build_front(output, args.site)
    else:
        build_collect(output, args.data, args.regions, args.bbox, args.history)
    if not args.no_serve:
        serve(output, args.port)


if __name__ == "__main__":
    main()
