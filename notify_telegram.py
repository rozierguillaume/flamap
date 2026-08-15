#!/usr/bin/env python3
"""Compare le jeu de données fraîchement collecté à celui déjà publié et
rédige le message Telegram correspondant.

Bibliothèque standard uniquement, comme `fetch_fires.py`. Le script ne parle
pas à Telegram : il écrit `fresh` et `message` dans `$GITHUB_OUTPUT` et laisse
le workflow poster. Ça le rend exécutable en local, sans jeton, pour relire un
message avant de l'envoyer :

    python3 notify_telegram.py --prev prev --data data

La référence « avant » est le site publié, repris par le workflow au même
endroit que l'historique FIRMS. Sans référence complète, le script se taît :
annoncer 16 000 foyers « nouveaux » parce que le téléchargement a échoué serait
pire que de rater une mise à jour.
"""

import argparse
import hashlib
import json
import os
import pathlib
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from flamap.geo import in_any_bbox

SITE = "https://flamap.fr"
PARIS = ZoneInfo("Europe/Paris")
MONTHS = ["janv.", "févr.", "mars", "avril", "mai", "juin", "juil.",
          "août", "sept.", "oct.", "nov.", "déc."]
# Un gros incendie fait éclore des dizaines de périmètres EFFIS le même jour :
# les lister tous produirait un pavé illisible sur téléphone.
MAX_LISTED = 5


def zone_center(zone_id, tile_deg):
    """Centre d'une cellule, depuis son identifiant `x+00_y+41`."""
    x, _, y = zone_id.partition("_")
    return int(x[1:]) + tile_deg / 2, int(y[1:]) + tile_deg / 2


def notified_regions(manifest):
    """Identifiants des régions que le canal annonce, `None` s'il n'y en a pas.

    `None` vaut « ne filtre rien » : un manifeste antérieur aux régions décrit
    un jeu entièrement français.
    """
    regions = manifest.get("regions")
    if not isinstance(regions, list):
        return None
    return {region.get("id") for region in regions if region.get("notify")}


def notified_zones(manifest, zone_ids):
    """Restreint le diff aux régions que le canal annonce.

    Le canal est francophone et nomme des communes françaises : les régions
    collectées mais non annoncées — l'Ibérie — sont cartographiées sans être
    commentées. Un manifeste antérieur à `regions` n'est pas filtré : il n'y
    avait alors qu'une région, la France.
    """
    regions = manifest.get("regions")
    if not isinstance(regions, list):
        return zone_ids
    boxes = [
        box for region in regions if region.get("notify")
        for box in region.get("boxes", [])
    ]
    if not boxes:
        return []
    tile_deg = manifest.get("tile_deg", 1)
    return [
        zone_id for zone_id in zone_ids
        if in_any_bbox(boxes, *zone_center(zone_id, tile_deg))
    ]


def announced(prop, regions):
    """Un objet EFFIS relève-t-il d'une région annoncée ?

    Les cellules de bordure sont partagées : borner le diff aux cellules du
    domaine français y laisse entrer les périmètres espagnols, qui seraient
    annoncés avec leur commune espagnole. La région d'origine, posée à la
    collecte, est le seul discriminant — la couche NRT n'a même pas de pays.

    Un objet sans région est un objet collecté avant cette distinction : il est
    conservé, sans quoi la première comparaison avec le site publié verrait
    chaque périmètre français comme une nouveauté.
    """
    if regions is None:
        return True
    origin = prop.get("_r")
    return origin is None or origin in regions


def load_zones(root, zone_ids, regions=None):
    """Renvoie les ensembles d'identifiants d'un jeu de paquets de zones.

    `missing` remonte les zones absentes : c'est le seul moyen de distinguer un
    site partiellement repris d'un vrai jeu de données.
    """
    hotspots = {}
    dated = {}
    nrt = set()
    missing = []
    for zone_id in zone_ids:
        path = root / f"{zone_id}.json"
        try:
            zone = json.loads(path.read_text())
        except Exception:
            missing.append(zone_id)
            continue
        for feature in zone.get("hotspots", {}).get("features", []):
            prop = feature["properties"]
            lon, lat = feature["geometry"]["coordinates"]
            # Les coordonnées sont arrondies à l'écriture, donc stables d'une
            # publication à l'autre : la clé ne dérive pas.
            hotspots[(prop.get("source"), prop.get("ts"), lon, lat)] = prop
        for feature in zone.get("burnt_dated", {}).get("features", []):
            prop = feature["properties"]
            if prop.get("_id") and announced(prop, regions):
                dated[prop["_id"]] = prop
        for feature in zone.get("burnt_nrt", {}).get("features", []):
            prop = feature.get("properties", {})
            if prop.get("_id") and announced(prop, regions):
                nrt.add(prop["_id"])
    return {"hotspots": hotspots, "dated": dated, "nrt": nrt,
            "missing": missing}


def french_date(ts, with_time=True):
    moment = datetime.fromtimestamp(ts, timezone.utc).astimezone(PARIS)
    day = f"{moment.day} {MONTHS[moment.month - 1]}"
    if not with_time:
        return day
    return f"{day} à {moment.hour} h {moment.minute:02d}"


def escape(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;"))


def plural(count, singular, suffix="s"):
    return singular if abs(count) < 2 else f"{singular}{suffix}"


def compose(new_hotspots, new_dated, new_nrt):
    """Construit le message en HTML Telegram."""
    lines = ["🔥 <b>Flamap · nouvelles données</b>"]

    if new_hotspots:
        by_source = {}
        for source, _ts, _lon, _lat in new_hotspots:
            by_source[source] = by_source.get(source, 0) + 1
        latest = max(key[1] for key in new_hotspots)
        peak = max(prop.get("frp") or 0 for prop in new_hotspots.values())
        detail = " · ".join(
            f"{escape(source or 'source inconnue')} {count}"
            for source, count in sorted(by_source.items(),
                                        key=lambda item: -item[1])
        )
        lines.append("")
        lines.append(f"🛰 <b>{len(new_hotspots)} nouveaux foyers</b> détectés")
        lines.append(detail)
        lines.append(f"Dernier passage {french_date(latest)} · "
                     f"foyer le plus intense {peak:.0f} MW")

    if new_dated:
        ranked = sorted(
            new_dated.values(),
            key=lambda prop: -(float(prop.get("AREA_HA") or 0)),
        )
        count = len(ranked)
        lines.append("")
        lines.append(f"🟧 <b>{count} nouveau{'x' if count > 1 else ''} "
                     f"{plural(count, 'périmètre')} EFFIS</b>")
        for prop in ranked[:MAX_LISTED]:
            where = escape(prop.get("COMMUNE") or "commune inconnue")
            province = prop.get("PROVINCE")
            if province:
                where += f" ({escape(province)})"
            area = float(prop.get("AREA_HA") or 0)
            piece = f"{where} — {area:.0f} ha"
            if prop.get("ts"):
                piece += f", feu du {french_date(prop['ts'], with_time=False)}"
            lines.append(piece)
        if count > MAX_LISTED:
            lines.append(f"… et {count - MAX_LISTED} autres")

    if new_nrt:
        # La couche NRT n'a ni date ni surface ni commune (voir SOURCES.md) :
        # elle ne peut être annoncée qu'en nombre.
        lines.append("")
        lines.append(f"🟨 {new_nrt} nouvelle{'s' if new_nrt > 1 else ''} "
                     f"{plural(new_nrt, 'emprise')} EFFIS NRT "
                     f"(sans commune ni surface)")

    lines.append("")
    lines.append(f'<a href="{SITE}">flamap.fr</a>')
    return "\n".join(lines)


def emit(outputs):
    """Écrit les sorties de l'étape, y compris le message multiligne."""
    target = os.environ.get("GITHUB_OUTPUT")
    if not target:
        return
    with open(target, "a", encoding="utf-8") as handle:
        for name, value in outputs.items():
            if "\n" in str(value):
                handle.write(f"{name}<<FLAMAP_EOF\n{value}\nFLAMAP_EOF\n")
            else:
                handle.write(f"{name}={value}\n")


def push_event(manifest, hotspots):
    """Événement géolocalisé et idempotent, distinct du rendu Telegram.

    Les périmètres EFFIS n'ont pas ici de point représentatif fiable ; leur
    intersection géométrique sera traitée côté notifications dans une étape
    dédiée. Les foyers FIRMS, eux, portent leur position exacte.
    """
    changes = [
        {"kind": "hotspot", "lon": lon, "lat": lat}
        for _source, _ts, lon, lat in sorted(hotspots)
    ]
    if not changes:
        return None
    useful = json.dumps(changes, sort_keys=True, separators=(",", ":"))
    generated = manifest.get("generated_at")
    try:
        published_at = int(datetime.fromisoformat(generated.replace("Z", "+00:00")).timestamp())
    except (AttributeError, ValueError):
        published_at = int(datetime.now(timezone.utc).timestamp())
    return {
        "event_key": hashlib.sha256(useful.encode("utf-8")).hexdigest(),
        "published_at": published_at,
        "changes": changes,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prev", default="prev",
                        help="racine du jeu publié repris (défaut : prev)")
    parser.add_argument("--data", default="data",
                        help="racine du jeu fraîchement collecté")
    args = parser.parse_args()

    prev_root = pathlib.Path(args.prev)
    data_root = pathlib.Path(args.data)

    try:
        prev_manifest = json.loads((prev_root / "manifest.json").read_text())
        manifest = json.loads((data_root / "manifest.json").read_text())
    except Exception as error:
        print(f"::warning::Pas de référence publiée exploitable ({error}) ; "
              "aucune notification.")
        emit({"fresh": "false", "push": "false"})
        return 0

    # Le manifeste de la référence ne liste que les zones réellement reprises :
    # c'est lui qui borne le diff des deux côtés. Une tuile absente de la
    # référence est donc muette pour ce cycle, plutôt que toute neuve.
    zones = prev_manifest.get("zones", [])
    skipped = len(manifest.get("zones", [])) - len(zones)
    if skipped > 0:
        print(f"{skipped} {plural(skipped, 'zone')} hors référence, "
              f"{plural(skipped, 'écartée')} du diff")
    # Le filtre vient du manifeste frais : c'est lui qui décrit les régions du
    # jeu qu'on est en train de comparer.
    zones, collected = notified_zones(manifest, zones), len(zones)
    silent = collected - len(zones)
    if silent > 0:
        print(f"{silent} {plural(silent, 'zone')} hors périmètre d'annonce, "
              f"{plural(silent, 'cartographiée')} sans être {plural(silent, 'commentée')}")
    regions = notified_regions(manifest)

    before = load_zones(prev_root / "zones", zones, regions)
    if before["missing"]:
        count = len(before["missing"])
        print(f"::warning::{count} {plural(count, 'zone')} "
              f"{plural(count, 'manque', 'nt')} dans la référence publiée ; "
              "aucune notification pour ce cycle.")
        emit({"fresh": "false", "push": "false"})
        return 0

    after = load_zones(data_root / "zones", zones, regions)
    if after["missing"]:
        # Le garde-fou du workflow a déjà vérifié la complétude ; si ça arrive
        # quand même, mieux vaut ne rien annoncer que d'annoncer à moitié.
        sys.exit(f"zones absentes du jeu collecté : {after['missing'][:5]}")

    new_hotspots = {key: prop for key, prop in after["hotspots"].items()
                    if key not in before["hotspots"]}
    new_dated = {key: prop for key, prop in after["dated"].items()
                 if key not in before["dated"]}
    new_nrt = len(after["nrt"] - before["nrt"])

    print(f"{len(new_hotspots)} nouveaux foyers, {len(new_dated)} nouveaux "
          f"périmètres datés, {new_nrt} nouvelles emprises NRT "
          f"(référence : {len(before['hotspots'])} foyers)")

    if not new_hotspots and not new_dated and not new_nrt:
        print("Rien de neuf depuis la publication précédente.")
        emit({"fresh": "false", "push": "false"})
        return 0

    message = compose(new_hotspots, new_dated, new_nrt)
    print("--- message ---")
    print(message)
    event = push_event(manifest, new_hotspots)
    if event:
        pathlib.Path("notification.json").write_text(
            json.dumps(event, separators=(",", ":")), encoding="utf-8"
        )
    emit({"fresh": "true", "message": message, "push": str(bool(event)).lower()})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
