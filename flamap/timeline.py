"""Construction des frises d'observation et de publication."""

import json
import os


HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "data")
SOCIAL_DAYS = 14


def build_timeline(hotspots, dated):
    """Passages nationaux exacts, independants des donnees detaillees chargees."""
    steps = []
    current_by_source = {}
    gap = 25 * 60
    for feature in hotspots["features"]:
        prop = feature["properties"]
        current = current_by_source.get(prop["source"])
        if (
            current
            and prop["ts"] - current["last"] <= gap
        ):
            current["n"] += 1
            current["frp"] += prop["frp"]
            current["last"] = prop["ts"]
            continue
        current = {
            "ts": prop["ts"],
            "last": prop["ts"],
            "kind": "sat",
            "label": prop["source"],
            "n": 1,
            "frp": prop["frp"],
        }
        current_by_source[prop["source"]] = current
        steps.append(current)

    first = steps[0]["ts"] if steps else 0
    # Une publication EFFIS peut mettre a jour plusieurs perimetres. Les
    # regrouper donne a la frise, et au journal d'information, une mesure utile
    # de chaque reponse du service plutot qu'une simple date repetitive.
    effis_updates = {}
    for feature in dated["features"]:
        prop = feature["properties"]
        stamp = prop.get("lu")
        if not stamp or stamp < first:
            continue
        update = effis_updates.setdefault(stamp, {"n": 0, "ha": 0})
        update["n"] += 1
        try:
            update["ha"] += float(prop.get("AREA_HA") or 0)
        except (TypeError, ValueError):
            pass
    for stamp, update in effis_updates.items():
        steps.append({"ts": stamp, "kind": "effis", "label": "EFFIS",
                      "n": update["n"], "ha": round(update["ha"], 1)})

    for step in steps:
        step.pop("last", None)
        if step["kind"] == "sat":
            step["frp"] = round(step["frp"], 2)
    return sorted(steps, key=lambda step: step["ts"])


def build_social_timeline(timeline, *, out=None, social_days=None):
    """Conserve quatorze jours de passages pour la carte de publication.

    La frise cartographique reste volontairement bornee a dix jours. Ce petit
    historique agrege est prolonge a chaque collecte sans conserver les lourds
    pixels FIRMS correspondants. Un passage du flux courant remplace l'ancien
    passage du meme satellite situe dans la meme fenetre orbitale.
    """
    out = OUT if out is None else out
    social_days = SOCIAL_DAYS if social_days is None else social_days
    current = [dict(step) for step in timeline if step.get("kind") == "sat"]
    if not current:
        return []
    latest = max(step["ts"] for step in current)
    cutoff = latest - social_days * 86400
    path = os.path.join(out, "social_timeline.json")
    previous = []
    try:
        with open(path, encoding="utf-8") as source:
            loaded = json.load(source)
        if isinstance(loaded, list):
            previous = loaded
    except (OSError, ValueError):
        pass

    gap = 25 * 60
    merged = list(current)
    current_by_source = {}
    for step in current:
        current_by_source.setdefault(step.get("label"), []).append(step["ts"])
    for step in previous:
        if (
            step.get("kind") != "sat"
            or not isinstance(step.get("ts"), (int, float))
            or step["ts"] < cutoff
            or any(abs(step["ts"] - stamp) <= gap
                   for stamp in current_by_source.get(step.get("label"), []))
        ):
            continue
        merged.append(step)
    return sorted((step for step in merged if step["ts"] >= cutoff),
                  key=lambda step: step["ts"])
