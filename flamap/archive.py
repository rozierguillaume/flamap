"""Enregistrements du journal d'archive, dérivés des exports courants.

Le site publié ne garde qu'une fenêtre glissante : dix jours de foyers, la
saison EFFIS en cours, sept jours de PSFDF. Ce module convertit une collecte en
lignes destinées au journal append-only conservé hors du site.

Aucune écriture ici, volontairement : les fonctions restent pures pour être
testables sans réseau ni système de fichiers. La mise en fichier appartient à
`scripts/archive_push.py`, la fusion au serveur.

Trois métadonnées sont ajoutées à chaque ligne, préfixées comme `_id` l'est
déjà côté EFFIS :

- `_k` : empreinte du contenu utile, seule base de la déduplication ;
- `_p` : partition mensuelle de destination ;
- `_seen` : instant de la collecte qui a vu cet état pour la première fois.

Calculer `_k` et `_p` ici plutôt que sur le serveur garde toute la connaissance
des sources dans le dépôt, testée : le fusionneur du VPS n'a aucune notion de
foyer, de périmètre ou de statut.
"""

import hashlib
import json
from datetime import datetime, timezone


ARCHIVE_STREAMS = ("firms", "effis", "effis_nrt", "psfdf", "wind")

# Une heure de vent déjà passée au moment de la collecte ne bouge plus. Mesuré
# sur deux exports distants de neuf jours : les 39 heures antérieures à leur
# génération sont identiques au bit près, les 26 suivantes — la queue de
# prévision, réécrite à chaque run du modèle — diffèrent sur la quasi-totalité
# des points, jusqu'à 8 m/s. La coupure tombe une à deux heures avant la
# génération, l'analyse n'ayant pas encore rattrapé l'heure courante.
#
# N'archiver qu'en deçà de ce seuil ramène le vent à une version par heure, là
# où archiver la prévision en produirait quarante-huit. La marge de trois heures
# couvre la coupure observée, et les dix jours de fenêtre passée
# (`WIND_PAST_DAYS`) garantissent qu'aucune heure n'est perdue pour autant :
# elle sera reprise par la collecte suivante, ou par celle d'après-demain.
WIND_SETTLED_S = 3 * 3600


def canonical(record):
    """Sérialisation stable du contenu utile, hors métadonnées d'archive."""
    payload = {
        key: value for key, value in record.items() if not key.startswith("_")
    }
    return json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )


def record_key(record):
    """Empreinte 64 bits signée du contenu, directement stockable en SQLite.

    Une collision ferait perdre silencieusement un enregistrement. Sur 64 bits
    et pour l'ordre de grandeur attendu — quelques millions de lignes après une
    décennie — la probabilité reste sous 10^-5, très en deçà du risque de perdre
    une collecte pour indisponibilité d'une source.
    """
    digest = hashlib.blake2b(canonical(record).encode("utf-8"), digest_size=8)
    return int.from_bytes(digest.digest(), "big", signed=True)


def period(ts):
    """Partition mensuelle UTC d'un horodatage epoch."""
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m")


def stamp(record, *, seen, at):
    """Complète un enregistrement de ses trois métadonnées d'archive."""
    record["_k"] = record_key(record)
    record["_p"] = period(at)
    record["_seen"] = int(seen)
    return record


def firms_records(hotspots, seen):
    """Détections unitaires ; leur contenu ne change jamais après émission."""
    for feature in hotspots.get("features", []):
        coordinates = feature.get("geometry", {}).get("coordinates", [])
        if len(coordinates) < 2:
            continue
        prop = feature.get("properties", {})
        ts = prop.get("ts")
        yield stamp({
            # Cinq décimales valent environ un mètre : bien en deçà des 375 m
            # de VIIRS, et à l'abri d'une variation de formatage qui créerait
            # un doublon pour une détection déjà archivée.
            "lon": round(float(coordinates[0]), 5),
            "lat": round(float(coordinates[1]), 5),
            "ts": int(ts) if ts else None,
            "source": prop.get("source"),
            "brightness": prop.get("brightness"),
            "frp": prop.get("frp"),
            "confidence": prop.get("confidence"),
            "daynight": prop.get("daynight"),
            "scan": prop.get("scan"),
            "track": prop.get("track"),
        }, seen=seen, at=ts or seen)


def effis_records(dated, seen):
    """Versions de périmètre daté, géométrie comprise.

    La clé porte sur tout le contenu, géométrie incluse, et non sur le seul
    `LASTUPDATE` : EFFIS affine parfois un contour sans avancer sa date de mise
    à jour, et c'est justement cette révision qu'on veut conserver.
    """
    for feature in dated.get("features", []):
        prop = dict(feature.get("properties", {}))
        identifier = prop.pop("_id", None)
        ts = prop.pop("ts", None)
        lu = prop.pop("lu", None) or ts
        # Les clés préfixées sont nos métadonnées de collecte, pas des attributs
        # EFFIS. Les laisser entrer dans l'empreinte referait une ligne neuve
        # pour chaque périmètre déjà archivé le jour où l'une d'elles change.
        prop = {key: value for key, value in prop.items()
                if not key.startswith("_")}
        yield stamp({
            "id": identifier,
            "ts": ts,
            "lu": lu,
            "area_ha": prop.get("AREA_HA"),
            "country": prop.get("COUNTRY"),
            "props": prop,
            "geometry": feature.get("geometry"),
        }, seen=seen, at=lu or seen)


def effis_nrt_records(nrt, seen):
    """Cicatrices NRT, sans aucun attribut ni date propre.

    L'identifiant est déjà l'empreinte de la géométrie : une cicatrice retouchée
    devient une nouvelle ligne, ce qui donne à cette couche muette le seul
    versionnement possible. La partition suit l'instant de collecte, faute de
    date d'observation.
    """
    for feature in nrt.get("features", []):
        identifier = feature.get("properties", {}).get("_id")
        yield stamp({
            "id": identifier,
            "geometry": feature.get("geometry"),
        }, seen=seen, at=seen)


def psfdf_records(psfdf, seen):
    """États successifs des incendies suivis.

    Toutes les propriétés entrent dans la clé, y compris les moyens engagés :
    c'est la trajectoire complète d'un feu qu'on archive, pas seulement ses
    changements de statut.

    `updated_ts` absent ne fait pas écarter la fiche : elle est alors rangée
    dans le mois de la collecte. Un incendie perdu parce qu'un champ a changé de
    nom serait exactement l'accident que ce journal existe pour éviter, et la
    clé de contenu suffit à ne pas le dupliquer d'une collecte à l'autre.
    """
    for feature in psfdf.get("features", []):
        prop = dict(feature.get("properties", {}))
        updated_ts = prop.get("updated_ts") or seen
        coordinates = feature.get("geometry", {}).get("coordinates", [])
        record = dict(prop)
        record["lon"] = round(float(coordinates[0]), 5) if coordinates else None
        record["lat"] = round(float(coordinates[1]), 5) if len(coordinates) > 1 else None
        yield stamp(record, seen=seen, at=updated_ts)


def wind_records(fields, seen):
    """Grilles horaires, une ligne par champ et par cran déjà observé.

    Le champ grossier d'une région et le champ fin d'une cellule ont exactement
    la même forme, à leur maille près : une seule fonction les traite, et
    `field` les distingue. Cet identifiant entre dans l'empreinte, comme `model`
    et la géométrie de grille : un champ qui change de modèle — bascule AROME
    vers `best_match` — n'est pas le même champ, et sa fenêtre doit être
    réarchivée.

    La partition suit l'heure météorologique, pas la collecte : une heure de
    juillet archivée le 2 août appartient à juillet.

    Le champ fin n'existe que pour les cellules actives au moment de la
    collecte, et rien ne pourra le reconstruire ensuite : c'est justement ce que
    ce journal existe pour retenir.
    """
    cutoff = int(seen) - WIND_SETTLED_S
    for name, grid in sorted((fields or {}).items()):
        if not grid:
            continue
        t0, dt = grid.get("t0"), grid.get("dt")
        if not t0 or not dt:
            continue
        for index in range(len(grid.get("u", []))):
            ts = t0 + index * dt
            # Les crans sont croissants par construction : le premier qui
            # dépasse le seuil clôt le champ.
            if ts > cutoff:
                break
            yield stamp({
                "field": name,
                "model": grid.get("model"),
                "bbox": grid.get("bbox"),
                "nx": grid.get("nx"),
                "ny": grid.get("ny"),
                "ts": ts,
                "u": grid["u"][index],
                "v": grid["v"][index],
                "gust": grid["gust"][index],
            }, seen=seen, at=ts)


def build_lot(export, seen):
    """Rassemble une collecte complète en lignes prêtes pour le journal."""
    return {
        "firms": list(firms_records(export.get("hotspots", {}), seen)),
        "effis": list(effis_records(export.get("burnt_dated", {}), seen)),
        "effis_nrt": list(effis_nrt_records(export.get("burnt_nrt", {}), seen)),
        "psfdf": list(psfdf_records(export.get("psfdf", {}), seen)),
        "wind": list(wind_records(export.get("wind", {}), seen)),
    }
