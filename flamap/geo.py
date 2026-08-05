"""Utilitaires geographiques purs du collecteur."""

import math


def swap_axes(geometry):
    """EFFIS emet [lat, lon], y compris dans des GeometryCollection."""
    def walk(coords):
        if isinstance(coords[0], (int, float)):
            return [coords[1], coords[0]]
        return [walk(child) for child in coords]

    if "coordinates" in geometry:
        geometry["coordinates"] = walk(geometry["coordinates"])
    for child in geometry.get("geometries", []):
        swap_axes(child)
    return geometry


def bbox_contains(bbox, lon, lat):
    west, south, east, north = bbox
    return west <= lon <= east and south <= lat <= north


def in_any_bbox(boxes, lon, lat):
    """Le domaine collecte est une reunion de rectangles, pas un seul.

    Un rectangle unique autour de la peninsule iberique attraperait le Rif et
    tout le littoral algerien, qui brulent beaucoup l'ete : les foyers FIRMS y
    apparaitraient sans le moindre perimetre EFFIS en face.
    """
    return any(bbox_contains(bbox, lon, lat) for bbox in boxes)


def union_bbox(boxes):
    boxes = list(boxes)
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )


def geometry_points(geometry):
    def walk(coords):
        if (
            isinstance(coords, list)
            and len(coords) >= 2
            and isinstance(coords[0], (int, float))
        ):
            yield coords
        elif isinstance(coords, list):
            for child in coords:
                yield from walk(child)

    if "coordinates" in geometry:
        yield from walk(geometry["coordinates"])
    for child in geometry.get("geometries", []):
        yield from geometry_points(child)


def feature_bounds(feature):
    points = list(geometry_points(feature["geometry"]))
    lon = [point[0] for point in points]
    lat = [point[1] for point in points]
    return min(lon), min(lat), max(lon), max(lat)


def geographic_distance_km(a, b):
    """Distance locale suffisante pour les rapprochements métropolitains."""
    latitude = math.radians((a[1] + b[1]) / 2)
    dx = (a[0] - b[0]) * math.cos(latitude) * 111.32
    dy = (a[1] - b[1]) * 110.57
    return math.hypot(dx, dy)


def point_bounds_distance_km(point, bounds):
    west, south, east, north = bounds
    nearest = [min(max(point[0], west), east),
               min(max(point[1], south), north)]
    return geographic_distance_km(point, nearest)


def bounds_gap_km(left, right):
    """Distance entre deux bboxes, nulle quand elles se touchent."""
    lon_gap = max(left[0] - right[2], right[0] - left[2], 0)
    lat_gap = max(left[1] - right[3], right[1] - left[3], 0)
    latitude = math.radians((left[1] + left[3] + right[1] + right[3]) / 4)
    return math.hypot(lon_gap * math.cos(latitude) * 111.32,
                      lat_gap * 110.57)
