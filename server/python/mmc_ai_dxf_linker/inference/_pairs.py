"""Internal: enumerate candidate (text, geometry) pairs from a parsed DXF.

This matches the ordering used at training time so node indices line up with
the graph built by :mod:`_graph`. Each text node (text or DIMENSION entity)
with a parseable numeric value becomes a candidate pair with each nearby
geometry node (line / arc / circle) within ``max_distance_frac`` of the
drawing diagonal.
"""

from __future__ import annotations

import math
import random

_RADIUS_PREFIXES = ("R", "r")
_DIAMETER_PREFIXES = ("∅", "Ø", "ø", "Φ", "φ", "ϕ", "⌀")
_UNIT_SUFFIXES = (
    "kg", "kgf", "mm", "cm", "mt", "kn", "kw", "kva", "ton", "t",
    "deg", "°", "rpm", "rad",
)


def _clean(text: str) -> str:
    """Drop unpaired UTF-16 surrogates, unit suffixes and trailing punctuation."""
    if not text:
        return ""
    text = "".join(
        ch for ch in text
        if not (0xDC00 <= ord(ch) <= 0xDFFF or 0xD800 <= ord(ch) <= 0xDBFF)
    ).strip()
    low = text.lower()
    for u in _UNIT_SUFFIXES:
        if low.endswith(u) and len(low) > len(u):
            text = text[: -len(u)].rstrip()
            break
    return text.rstrip(",.;:")


def _decomma(num: str) -> str:
    """Strip thousand separators while preserving European decimal commas."""
    if "," not in num:
        return num
    c = num.count(",")
    last = num.rfind(",")
    tail = num[last + 1:]
    if c == 1 and 1 <= len(tail) <= 2 and tail.isdigit():
        return num.replace(",", ".")
    return num.replace(",", "")


def parse_numeric(text: str):
    """Return ``(value, kind)`` or ``None`` where kind ∈ {radius, diameter, length}."""
    s = _clean(text)
    if not s:
        return None
    for p in _DIAMETER_PREFIXES:
        if s.startswith(p):
            try:
                return float(_decomma(s[len(p):].strip())), "diameter"
            except ValueError:
                pass
    for p in _RADIUS_PREFIXES:
        if s.startswith(p) and len(s) > 1 and s[len(p)].isdigit():
            try:
                return float(_decomma(s[len(p):].strip())), "radius"
            except ValueError:
                pass
    if s.endswith("R") and len(s) > 1:
        try:
            return float(_decomma(s[:-1].strip())), "radius"
        except ValueError:
            pass
    try:
        return float(_decomma(s)), "length"
    except ValueError:
        return None


def _geom_measure(entity: dict, etype: str):
    if etype == "lines":
        return entity.get("length", 0), "length"
    if etype in ("arcs", "circles"):
        return entity.get("radius", 0), "radius"
    return 0, "unknown"


def build_link_pairs(parsed: dict, tolerance_frac: float = 0.05,
                     max_distance_frac: float = 0.3,
                     max_negatives_per_text: int = 3) -> dict | None:
    """Enumerate candidate (text, geometry) pairs within spatial reach.

    A pair is labelled *positive* (value matches geometry measurement within
    ``tolerance_frac``) or *negative* (nearby but no match). Negatives are
    down-sampled to keep the class ratio manageable.
    """
    bounds = parsed.get("bounds", {})
    if not bounds or bounds.get("width", 0) < 1:
        return None
    diag = math.hypot(bounds.get("width", 1), bounds.get("height", 1))
    max_dist = diag * max_distance_frac

    all_entities = []
    node_idx = 0
    for etype in ("lines", "arcs", "circles", "texts", "dimensions"):
        for entity in parsed.get(etype, []):
            all_entities.append((node_idx, etype, entity))
            node_idx += 1

    text_nodes, geom_nodes = [], []
    for idx, etype, entity in all_entities:
        if etype in ("texts", "dimensions"):
            parsed_val = parse_numeric(entity.get("text", ""))
            if parsed_val is None:
                continue
            value, kind = parsed_val
            text_nodes.append({
                "idx": idx, "value": value, "kind": kind,
                "x": entity.get("x", 0), "y": entity.get("y", 0),
            })
        elif etype in ("lines", "arcs", "circles"):
            value, kind = _geom_measure(entity, etype)
            if value <= 0:
                continue
            if etype == "lines":
                cx = (entity["x1"] + entity["x2"]) / 2
                cy = (entity["y1"] + entity["y2"]) / 2
            else:
                cx = entity.get("cx", 0)
                cy = entity.get("cy", 0)
            geom_nodes.append({"idx": idx, "value": value, "kind": kind,
                               "cx": cx, "cy": cy})

    if not text_nodes or not geom_nodes:
        return None

    positives, negatives = [], []
    for tn in text_nodes:
        cands = []
        for gn in geom_nodes:
            dist = math.hypot(tn["x"] - gn["cx"], tn["y"] - gn["cy"])
            if dist >= max_dist:
                continue
            tol = max(tn["value"] * tolerance_frac, 0.5)
            matched = False
            if tn["kind"] == "radius" and gn["kind"] == "radius":
                matched = abs(tn["value"] - gn["value"]) < tol
            elif tn["kind"] == "diameter" and gn["kind"] == "radius":
                matched = abs(tn["value"] - gn["value"] * 2) < tol
            elif tn["kind"] == "length" and gn["kind"] == "length":
                matched = abs(tn["value"] - gn["value"]) < tol
            pair = {
                "text_idx": tn["idx"], "geom_idx": gn["idx"],
                "distance": dist / diag,
                "value_ratio": min(tn["value"], gn["value"])
                               / max(tn["value"], gn["value"], 1e-6),
                "label": 1 if matched else 0,
            }
            (positives if matched else cands).append(pair)
        if cands:
            rng = random.Random(tn["idx"])
            negatives.extend(rng.sample(cands, min(max_negatives_per_text, len(cands))))

    if not positives and not negatives:
        return None
    return {"positive_pairs": positives, "negative_pairs": negatives}
