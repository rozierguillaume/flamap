"""Collecte et normalisation des perimetres Copernicus EFFIS."""

import hashlib
import json
import sys
import time
from datetime import datetime, timezone

from flamap.geo import swap_axes
from flamap.http import get


EFFIS_WFS = "https://maps.effis.emergency.copernicus.eu/effis"


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def effis_wfs(typename, bbox, timeout=300, *, http_get=None, base_url=None):
    http_get = get if http_get is None else http_get
    base_url = EFFIS_WFS if base_url is None else base_url
    west, south, east, north = bbox
    url = (
        f"{base_url}?service=WFS&version=1.0.0&request=GetFeature"
        f"&typename=ms:{typename}&outputformat=geojson"
        f"&bbox={west},{south},{east},{north}"
    )
    for attempt in range(3):
        try:
            return json.loads(http_get(url, timeout=timeout))
        except Exception:
            if attempt == 2:
                raise
            delay = 4 * (attempt + 1)
            print(f"  ! EFFIS {typename} indisponible, nouvel essai dans {delay} s",
                  file=sys.stderr)
            time.sleep(delay)


def to_epoch(value):
    if not value:
        return None
    try:
        return int(
            datetime.fromisoformat(str(value).replace(" ", "T"))
            .replace(tzinfo=timezone.utc)
            .timestamp()
        )
    except ValueError:
        return None


def stable_feature_id(feature, prefix):
    value = feature.get("properties", {}).get("id")
    if value in (None, ""):
        raw = json.dumps(
            feature["geometry"], sort_keys=True, separators=(",", ":")
        ).encode()
        value = hashlib.sha1(raw).hexdigest()[:16]
    return f"{prefix}-{value}"


def fetch_burnt(bbox, *, wfs=None, swap=None, epoch=None, feature_id=None):
    wfs = effis_wfs if wfs is None else wfs
    swap = swap_axes if swap is None else swap
    epoch = to_epoch if epoch is None else epoch
    feature_id = stable_feature_id if feature_id is None else feature_id
    dated = wfs("modis.ba.poly.season", bbox)
    kept = []
    for feature in dated["features"]:
        # La couche datee fournit le pays : ne pas envoyer au navigateur les
        # milliers de polygones espagnols et italiens pris dans la grande bbox.
        if feature["properties"].get("COUNTRY") != "FR":
            continue
        swap(feature["geometry"])
        prop = feature["properties"]
        prop["ts"] = epoch(prop.get("FIREDATE"))
        prop["lu"] = epoch(prop.get("LASTUPDATE")) or prop["ts"]
        prop["_id"] = feature_id(feature, "d")
        kept.append(feature)
    dated["features"] = sorted(
        kept, key=lambda feature: feature["properties"].get("FIREDATE") or ""
    )
    print(f"  EFFIS dates France : {len(kept)} polygones")

    try:
        nrt = wfs("effis.nrt.ba.poly", bbox)
    except Exception as error:
        # Cette couche est un complément sans attribut, qui contient aussi
        # d'anciennes cicatrices et ne participe ni à la frise ni au cadrage.
        # La perdre ponctuellement ne doit pas bloquer les foyers FIRMS et les
        # périmètres datés de la saison, qui restent obligatoires.
        print(f"  ! EFFIS NRT ignoré après les reprises : {error}",
              file=sys.stderr)
        nrt = fc([])
    for feature in nrt["features"]:
        swap(feature["geometry"])
        feature.setdefault("properties", {})["_id"] = feature_id(feature, "n")
    print(f"  EFFIS NRT bbox     : {len(nrt['features'])} polygones")
    return {"burnt_dated": dated, "burnt_nrt": nrt}


def burnt_since(dated, reference, days):
    threshold = reference - days * 86400
    return fc([
        feature for feature in dated["features"]
        # `lu` reprend LASTUPDATE ; EFFIS peut continuer a preciser le
        # perimetre plusieurs jours apres FIREDATE. Les classes Today/7DAYS
        # decrivent l'age du feu, pas la fraicheur de ce perimetre.
        if feature["properties"].get("lu", feature["properties"].get("ts", 0)) >= threshold
    ])
