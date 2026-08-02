"""Collecte et export des grilles Open-Meteo."""

import json
import math
import sys
import time
import urllib.error
from datetime import datetime, timezone

from flamap.http import get


OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
WIND_MODEL = "meteofrance_arome_france_hd"
WIND_PAST_DAYS = 10
WIND_SPACING_KM = 20
WIND_BATCH = 250
WIND_MARGIN_KM = 60
WIND_DETAIL_STRIDE = 3
WIND_COARSE_N = 15
THERMAL_SPACING_KM = 20
THERMAL_PAST_DAYS = 1
# Le vrai plafond d'un lot est la longueur de l'URL : 430 points tiennent dans
# l'URL Open-Meteo, alors que 1 000 points déclenchent un HTTP 414.
THERMAL_BATCH = 430
# Les points de vent fin de toutes les cellules actives voyagent ensemble : le
# quota dépend des variables et de la durée, pas du nombre de coordonnées.
FINE_WIND_BATCH = 430
# Le champ fin et la température sont des enrichissements : leurs budgets bornés
# ne doivent jamais empêcher la publication du champ national et des foyers.
FINE_WIND_DEADLINE = 8 * 60
THERMAL_DEADLINE = 6 * 60
WIND_REQUEST_PAUSE = 6
# Une réponse saine arrive en moins d'une seconde ; ce timeout fixe le coût
# d'un incident plutôt que de laisser quelques poignées TLS bloquer un cycle.
OPEN_METEO_TIMEOUT = 30


def wind_box(bbox, *, margin_km=None):
    margin_km = WIND_MARGIN_KM if margin_km is None else margin_km
    west, south, east, north = bbox
    mid = math.radians((south + north) / 2)
    dy = margin_km / 111.0
    dx = margin_km / (111.0 * math.cos(mid))
    return west - dx, south - dy, east + dx, north + dy


def wind_grid(box, spacing_km):
    west, south, east, north = box
    mid = math.radians((south + north) / 2)
    nx = max(2, round((east - west) * 111 * math.cos(mid) / spacing_km) + 1)
    ny = max(2, round((north - south) * 111 / spacing_km) + 1)
    points = [
        (
            round(south + (north - south) * iy / (ny - 1), 4),
            round(west + (east - west) * ix / (nx - 1), 4),
        )
        for iy in range(ny)
        for ix in range(nx)
    ]
    return nx, ny, points


def meteo_request(points, model, variables, past_days, *, http_get=None,
                  base_url=None, timeout=None):
    http_get = get if http_get is None else http_get
    base_url = OPEN_METEO if base_url is None else base_url
    timeout = OPEN_METEO_TIMEOUT if timeout is None else timeout
    lat = ",".join(str(point[0]) for point in points)
    lon = ",".join(str(point[1]) for point in points)
    url = (
        f"{base_url}?latitude={lat}&longitude={lon}"
        f"&hourly={','.join(variables)}"
        f"&past_days={past_days}&forecast_days=2"
        "&wind_speed_unit=ms&timezone=UTC"
    )
    if model:
        url += f"&models={model}"
    for attempt in range(4):
        try:
            data = json.loads(http_get(url, timeout=timeout))
            return data if isinstance(data, list) else [data]
        except Exception as error:
            if attempt == 3:
                raise
            if getattr(error, "code", None) == 429:
                delay = (10, 30, 60)[attempt]
                reason = "Open-Meteo limite le debit"
            elif (isinstance(error, (urllib.error.URLError, TimeoutError))
                  and not isinstance(error, urllib.error.HTTPError)):
                delay = (5, 15, 30)[attempt]
                reason = f"Open-Meteo injoignable ({error})"
            else:
                raise
            print(f"  ! {reason}, nouvel essai dans {delay} s", file=sys.stderr)
            time.sleep(delay)


class DeadlineExceeded(Exception):
    """Le budget de temps d'une serie de lots est epuise.

    Porte les series deja collectees : une grille tronquee est inutilisable,
    mais un ensemble de cellules dont les premieres sont completes reste bon a
    prendre. C'est au demandeur de trancher.
    """

    def __init__(self, message, collected):
        super().__init__(message)
        self.collected = collected


def request_batches(points, model, variables, past_days, batch_size=None,
                    budget=None, *, request=None, request_pause=None):
    batch_size = WIND_BATCH if batch_size is None else batch_size
    request = meteo_request if request is None else request
    request_pause = WIND_REQUEST_PAUSE if request_pause is None else request_pause
    batches = [
        points[index:index + batch_size]
        for index in range(0, len(points), batch_size)
    ]
    print(f"  {len(batches)} lots de {batch_size} points au plus")
    limit = None if budget is None else time.monotonic() + budget
    chunks = []
    for number, batch in enumerate(batches, 1):
        # Le contrôle porte sur le lot suivant : une série interrompue au milieu
        # ne donnerait aucune grille exploitable.
        if limit is not None and time.monotonic() > limit:
            raise DeadlineExceeded(
                f"{number - 1}/{len(batches)} lots en {budget:.0f} s",
                [series for chunk in chunks for series in chunk],
            )
        chunks.append(request(batch, model, variables, past_days))
        # Les runners GitHub partagent leurs IP : espacer les requêtes évite
        # qu'une série de grilles soit prise pour une rafale.
        time.sleep(request_pause)
    return [series for chunk in chunks for series in chunk]


def request_wind_batches(points, model, temperature=False, *, batches=None,
                         past_days=None):
    batches = request_batches if batches is None else batches
    past_days = WIND_PAST_DAYS if past_days is None else past_days
    variables = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"]
    if temperature:
        variables += ["temperature_2m", "precipitation"]
    return batches(points, model, variables, past_days)


def keep_recent(series, *, datetime_cls=None):
    """Indices et horodatages retenus : tout le passe, 24 h de prevision."""
    datetime_cls = datetime if datetime_cls is None else datetime_cls
    times = series[0]["hourly"]["time"]
    timestamps = [
        int(datetime_cls.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp())
        for value in times
    ]
    now = datetime_cls.now(timezone.utc).timestamp()
    keep = [index for index, stamp in enumerate(timestamps) if stamp <= now + 24 * 3600]
    return keep, [timestamps[index] for index in keep]


def wind_holes(series):
    holes = sum(
        value is None
        for location in series
        for value in location["hourly"]["wind_speed_10m"]
    )
    total = sum(len(location["hourly"]["wind_speed_10m"]) for location in series)
    return holes, total


def build_wind(box, nx, ny, series, model, temperature=False, *, recent_fn=None):
    """Convertit les series horaires d'un lot de points en grille exploitable."""
    recent_fn = keep_recent if recent_fn is None else recent_fn
    keep, timestamps = recent_fn(series)
    count = len(series)
    u = [[0.0] * count for _ in timestamps]
    v = [[0.0] * count for _ in timestamps]
    gust = [[0] * count for _ in timestamps]
    temp = [[None] * count for _ in timestamps] if temperature else None
    precipitation = [[None] * count for _ in timestamps] if temperature else None
    for column, location in enumerate(series):
        hourly = location["hourly"]
        for row, index in enumerate(keep):
            if temperature:
                value = hourly["temperature_2m"][index]
                temp[row][column] = round(value, 1) if value is not None else None
                value = hourly["precipitation"][index]
                precipitation[row][column] = round(value, 2) if value is not None else None
            speed = hourly["wind_speed_10m"][index]
            direction = hourly["wind_direction_10m"][index]
            if speed is None or direction is None:
                continue
            angle = math.radians(direction)
            u[row][column] = round(-speed * math.sin(angle), 1)
            v[row][column] = round(-speed * math.cos(angle), 1)
            value = hourly["wind_gusts_10m"][index]
            gust[row][column] = round(value * 3.6) if value is not None else 0
    result = {"model": model, "box": box, "nx": nx, "ny": ny,
              "t0": timestamps[0], "dt": 3600, "u": u, "v": v, "gust": gust}
    if temperature:
        result["temperature"] = temp
        result["precipitation"] = precipitation
    return result


def fetch_wind(box, spacing_km, label, temperature=False, *, grid=None,
               batches=None, holes_fn=None, build=None, wind_model=None):
    grid = wind_grid if grid is None else grid
    batches = request_wind_batches if batches is None else batches
    holes_fn = wind_holes if holes_fn is None else holes_fn
    build = build_wind if build is None else build
    wind_model = WIND_MODEL if wind_model is None else wind_model
    nx, ny, points = grid(box, spacing_km)
    dx = (box[2] - box[0]) * 111 * math.cos(math.radians((box[1] + box[3]) / 2))
    print(f"  {label} {nx}x{ny} = {len(points)} points, pas ~{dx / (nx - 1):.0f} km")
    series = batches(points, wind_model, temperature)
    holes, total = holes_fn(series)
    model = wind_model
    if holes > total * 0.2:
        print(f"  ! AROME HD : {holes}/{total} valeurs manquantes, bascule best_match",
              file=sys.stderr)
        series = batches(points, None, temperature)
        model = "best_match"
    result = build(box, nx, ny, series, model, temperature)
    print(f"  {len(result['u'])} heures, modele {model}")
    return result


def fetch_fine_winds(boxes, spacing_km, budget=None, *, grid=None, batches=None,
                     holes_fn=None, build=None, wind_model=None, past_days=None,
                     batch_size=None):
    """Vent fin de plusieurs cellules, en lots partages entre les cellules.

    Le découpage en cellules sert le navigateur, pas l'API : une requête par
    cellule gaspillerait des aller-retours alors que chaque grille peut être
    reconstruite depuis sa tranche de réponse.
    """
    grid = wind_grid if grid is None else grid
    batches = request_batches if batches is None else batches
    holes_fn = wind_holes if holes_fn is None else holes_fn
    build = build_wind if build is None else build
    wind_model = WIND_MODEL if wind_model is None else wind_model
    past_days = WIND_PAST_DAYS if past_days is None else past_days
    batch_size = FINE_WIND_BATCH if batch_size is None else batch_size
    grids, points = {}, []
    for key, box in boxes.items():
        nx, ny, cell = grid(box, spacing_km)
        grids[key] = (box, nx, ny, len(points), len(cell))
        points.extend(cell)
    print(f"  {len(boxes)} cellules, {len(points)} points au total")
    variables = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"]
    model = wind_model
    try:
        series = batches(points, wind_model, variables, past_days, batch_size, budget)
        holes, total = holes_fn(series)
        if holes > total * 0.2:
            print(f"  ! AROME HD : {holes}/{total} valeurs manquantes, bascule best_match",
                  file=sys.stderr)
            series = batches(points, None, variables, past_days, batch_size, budget)
            model = "best_match"
    except DeadlineExceeded as error:
        # Les cellules entièrement couvertes par les lots déjà reçus restent
        # exploitables ; les suivantes retombent sur le champ national.
        print(f"  ! vent fin ecourte ({error})", file=sys.stderr)
        series = error.collected
    result = {}
    for key, (box, nx, ny, start, count) in grids.items():
        if start + count <= len(series):
            result[key] = build(box, nx, ny, series[start:start + count], model)
    if not result:
        return {}
    hours = len(result[next(iter(result))]["u"])
    print(f"  {len(result)}/{len(boxes)} cellules, {hours} heures, modele {model}")
    return result


def fetch_thermal(box, spacing_km, *, grid=None, batches=None, wind_model=None,
                  past_days=None, batch_size=None, deadline=None, recent_fn=None):
    """Grille dédiée à la température, bien plus fine que celle du vent.

    La température à 2 m suit le relief ; le pas de 20 km réduit l'écart sans
    multiplier les requêtes du vent, qui varie plus lentement dans l'espace.
    Sa fenêtre courte (un jour passé, deux de prévision) paie ces points en
    plus, puisque le volet météo n'affiche que +/-12 h.
    """
    grid = wind_grid if grid is None else grid
    batches = request_batches if batches is None else batches
    wind_model = WIND_MODEL if wind_model is None else wind_model
    past_days = THERMAL_PAST_DAYS if past_days is None else past_days
    batch_size = THERMAL_BATCH if batch_size is None else batch_size
    deadline = THERMAL_DEADLINE if deadline is None else deadline
    recent_fn = keep_recent if recent_fn is None else recent_fn
    nx, ny, points = grid(box, spacing_km)
    dx = (box[2] - box[0]) * 111 * math.cos(math.radians((box[1] + box[3]) / 2))
    print(f"  grille thermique {nx}x{ny} = {len(points)} points, pas ~{dx / (nx - 1):.0f} km")
    variables = ["temperature_2m", "precipitation"]
    started = time.monotonic()
    def remaining():
        return deadline - (time.monotonic() - started)
    series = batches(points, wind_model, variables, past_days, batch_size, remaining())
    holes = sum(value is None for location in series
                for value in location["hourly"]["temperature_2m"])
    total = sum(len(location["hourly"]["temperature_2m"]) for location in series)
    model = wind_model
    if holes > total * 0.2:
        print(f"  ! AROME HD : {holes}/{total} temperatures manquantes, bascule best_match",
              file=sys.stderr)
        # La reprise partage le même budget : hors domaine AROME, mieux vaut
        # un champ large qu'une seconde série complète payée au prix du délai.
        series = batches(points, None, variables, past_days, batch_size, remaining())
        model = "best_match"
    keep, timestamps = recent_fn(series)
    temp = [[None] * len(points) for _ in timestamps]
    precipitation = [[None] * len(points) for _ in timestamps]
    for column, location in enumerate(series):
        hourly = location["hourly"]
        for row, index in enumerate(keep):
            value = hourly["temperature_2m"][index]
            temp[row][column] = round(value, 1) if value is not None else None
            value = hourly["precipitation"][index]
            precipitation[row][column] = round(value, 2) if value is not None else None
    print(f"  {len(timestamps)} heures, modele {model}")
    return {"model": model, "box": box, "nx": nx, "ny": ny,
            "t0": timestamps[0], "dt": 3600, "temperature": temp,
            "precipitation": precipitation}


def wind_subset(wind, xs, ys, time_stride=1):
    indices = [iy * wind["nx"] + ix for iy in ys for ix in xs]
    rows = range(0, len(wind["u"]), time_stride)
    x0, x1, y0, y1 = xs[0], xs[-1], ys[0], ys[-1]
    box = wind["box"]
    dx = (box[2] - box[0]) / (wind["nx"] - 1)
    dy = (box[3] - box[1]) / (wind["ny"] - 1)
    result = {"model": wind["model"], "unit": "m/s", "bbox": [round(box[0] + x0 * dx, 4), round(box[1] + y0 * dy, 4), round(box[0] + x1 * dx, 4), round(box[1] + y1 * dy, 4)], "nx": len(xs), "ny": len(ys), "t0": wind["t0"], "dt": wind["dt"] * time_stride, "nt": len(list(rows)), "u": [[wind["u"][row][index] for index in indices] for row in rows], "v": [[wind["v"][row][index] for index in indices] for row in rows], "gust": [[wind["gust"][row][index] for index in indices] for row in rows]}
    for name in ("temperature", "precipitation"):
        # Repli du volet météo et du badge si thermal.json manque ou si la frise
        # remonte au-delà de la fenêtre du champ fin.
        if name in wind:
            result[name] = [[wind[name][row][index] for index in indices] for row in rows]
    return result


def whole_wind(wind, time_stride=1):
    return wind_subset(wind, list(range(wind["nx"])), list(range(wind["ny"])), time_stride)


def weather_forecast(wind, now, hours=12):
    """Extrait 12 h passées et 12 h futures de vent pour le volet météo.

    Température et pluie vivent dans thermal.json, sur leur propre grille et
    leur propre base de temps : le navigateur les interpole séparément.
    """
    pivot = next((index for index in range(len(wind["u"])) if wind["t0"] + index * wind["dt"] >= now), len(wind["u"]))
    start, stop = max(0, pivot - hours), min(pivot + hours + 1, len(wind["u"]))
    rows = range(start, stop)
    return {"model": wind["model"], "bbox": [round(value, 4) for value in wind["box"]], "nx": wind["nx"], "ny": wind["ny"], "t0": wind["t0"] + start * wind["dt"], "dt": wind["dt"], "nt": stop - start, "u": [wind["u"][row] for row in rows], "v": [wind["v"][row] for row in rows], "gust": [wind["gust"][row] for row in rows]}


def thermal_export(thermal, now, hours=18):
    """Réduit la grille thermique à la fenêtre affichée par le volet météo.

    La fenêtre +/-18 h absorbe le décalage possible de six heures entre les
    collectes thermique et vent, qui ont des cadences indépendantes.
    """
    pivot = next((index for index in range(len(thermal["temperature"])) if thermal["t0"] + index * thermal["dt"] >= now), len(thermal["temperature"]))
    start = max(0, pivot - hours)
    stop = min(pivot + hours + 1, len(thermal["temperature"]))
    rows = range(start, stop)
    return {"model": thermal["model"], "bbox": [round(value, 4) for value in thermal["box"]], "nx": thermal["nx"], "ny": thermal["ny"], "t0": thermal["t0"] + start * thermal["dt"], "dt": thermal["dt"], "nt": stop - start, "temperature": [thermal["temperature"][row] for row in rows], "precipitation": [thermal["precipitation"][row] for row in rows]}


def fine_wind_tiles(recent, hotspots, latest, *, feature_tiles_fn, min_count):
    """Cellules avec feu confirme EFFIS ou rafale FIRMS recente significative."""
    keys = set()
    for feature in recent["features"]:
        keys.update(feature_tiles_fn(feature))
    counts = {}
    threshold = latest - 24 * 3600
    for feature in hotspots["features"]:
        if feature["properties"]["ts"] < threshold:
            continue
        lon, lat = feature["geometry"]["coordinates"]
        key = math.floor(lon), math.floor(lat)
        counts[key] = counts.get(key, 0) + 1
    keys.update(key for key, count in counts.items() if count >= min_count)
    return keys
