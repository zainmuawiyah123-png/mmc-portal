"""Internal: build a 29-dim enriched PyG graph from parsed DXF + raster image.

The encoder was trained on this exact feature layout, so downstream callers
must use the same builder. See ``data_format/graph_format.md`` for the schema.
"""

from __future__ import annotations

import math

import numpy as np
import torch
from scipy.spatial import KDTree
from torch_geometric.data import Data

EDGE_DIM = 5
NODE_DIM_GEOMETRY = 16
NODE_DIM_PIXEL = 13
NODE_DIM_ENRICHED = NODE_DIM_GEOMETRY + NODE_DIM_PIXEL  # 29


# -- Per-entity 16-dim geometry features ---------------------------------


def _line_features(e: dict, b: dict, diag: float) -> np.ndarray:
    dx, dy = e["x2"] - e["x1"], e["y2"] - e["y1"]
    length = e.get("length", math.hypot(dx, dy))
    cx, cy = (e["x1"] + e["x2"]) / 2, (e["y1"] + e["y2"]) / 2
    angle = math.atan2(dy, dx)
    return np.array([
        (cx - b["min_x"]) / max(b["width"], 1e-6),
        (cy - b["min_y"]) / max(b["height"], 1e-6),
        dx / max(length, 1e-6), dy / max(length, 1e-6),
        length / max(diag, 1e-6),
        0.0, angle / math.pi, e.get("width", 1.0),
        1, 0, 0, 0, 0, 1.0, 0.0, 0.0,
    ], dtype=np.float32)


def _arc_features(e: dict, b: dict, diag: float) -> np.ndarray:
    r = e["radius"]
    span = e.get("span", abs(e.get("end_angle", 0) - e.get("start_angle", 0)))
    arc_len = r * math.radians(span) if span > 0 else 0
    mid = math.radians((e.get("start_angle", 0) + e.get("end_angle", 0)) / 2)
    return np.array([
        (e["cx"] - b["min_x"]) / max(b["width"], 1e-6),
        (e["cy"] - b["min_y"]) / max(b["height"], 1e-6),
        math.cos(mid), math.sin(mid),
        arc_len / max(diag, 1e-6),
        1.0 / max(r, 1e-6) if r > 0 else 0,
        mid / math.pi, 1.0,
        0, 1, 0, 0, 0, 1.0, 0.0,
        min(r / max(diag, 1e-6), 1.0),
    ], dtype=np.float32)


def _circle_features(e: dict, b: dict, diag: float) -> np.ndarray:
    r = e["radius"]
    return np.array([
        (e["cx"] - b["min_x"]) / max(b["width"], 1e-6),
        (e["cy"] - b["min_y"]) / max(b["height"], 1e-6),
        0.0, 0.0,
        (2 * math.pi * r) / max(diag, 1e-6),
        1.0 / max(r, 1e-6) if r > 0 else 0,
        0.0, 1.0,
        0, 0, 1, 0, 0, 1.0, 0.0,
        min(r / max(diag, 1e-6), 1.0),
    ], dtype=np.float32)


def _text_features(e: dict, b: dict, diag: float) -> np.ndarray:
    return np.array([
        (e["x"] - b["min_x"]) / max(b["width"], 1e-6),
        (e["y"] - b["min_y"]) / max(b["height"], 1e-6),
        0.0, 0.0,
        e.get("height", 1.0) / max(diag, 1e-6),
        0.0, 0.0, 1.0,
        0, 0, 0, 1, 0, 0.5, 1.0, 0.0,
    ], dtype=np.float32)


# -- 13-dim pixel features along lines -----------------------------------


def _pixel_features(entity: dict, etype: str, img: np.ndarray, transform: dict,
                    n_samples: int = 40) -> np.ndarray:
    zero = np.zeros(NODE_DIM_PIXEL, dtype=np.float32)
    if etype != "lines":
        return zero
    scale = transform["scale"]
    margin = transform["margin_px"]
    canvas_h = transform["canvas_h"]
    min_x, min_y = transform["dxf_min_x"], transform["dxf_min_y"]

    def to_px(x, y):
        return ((x - min_x) * scale + margin,
                canvas_h - margin - (y - min_y) * scale)

    px1, py1 = to_px(entity["x1"], entity["y1"])
    px2, py2 = to_px(entity["x2"], entity["y2"])
    length_px = math.hypot(px2 - px1, py2 - py1)
    if length_px < 4:
        return zero
    h, w = img.shape[:2]
    xs = np.clip(np.linspace(px1, px2, n_samples).astype(int), 0, w - 1)
    ys = np.clip(np.linspace(py1, py2, n_samples).astype(int), 0, h - 1)
    intensities = img[ys, xs].astype(float)
    dark = intensities < 160
    dark_runs: list[int] = []
    gap_runs: list[int] = []
    current = 1
    for i in range(1, len(dark)):
        if dark[i] == dark[i - 1]:
            current += 1
        else:
            (dark_runs if dark[i - 1] else gap_runs).append(current)
            current = 1
    (dark_runs if dark[-1] else gap_runs).append(current)

    feats = np.array([
        length_px, entity.get("width", 1.0),
        np.mean(intensities), np.std(intensities),
        np.sum(dark) / max(len(dark), 1),
        len(dark_runs), len(gap_runs),
        np.mean(dark_runs) if dark_runs else 0,
        np.mean(gap_runs) if gap_runs else 0,
        np.std(dark_runs) if len(dark_runs) > 1 else 0,
        np.std(gap_runs) if len(gap_runs) > 1 else 0,
        max(dark_runs) if dark_runs else 0,
        max(gap_runs) if gap_runs else 0,
    ], dtype=np.float32)
    img_diag = math.hypot(w, h)
    feats[0] /= max(img_diag, 1)
    feats[1] = min(feats[1] / 10.0, 1.0)
    feats[2] /= 255.0
    feats[3] /= 128.0
    for i in (5, 6, 7, 8, 9, 10, 11, 12):
        feats[i] /= n_samples
    return feats


# -- Edge construction ---------------------------------------------------


def _line_endpoints(e: dict) -> list:
    return [(e["x1"], e["y1"]), (e["x2"], e["y2"])]


def _arc_endpoints(e: dict) -> list:
    cx, cy, r = e["cx"], e["cy"], e["radius"]
    sa = math.radians(e.get("start_angle", 0))
    ea = math.radians(e.get("end_angle", 0))
    return [(cx + r * math.cos(sa), cy + r * math.sin(sa)),
            (cx + r * math.cos(ea), cy + r * math.sin(ea))]


def _knn_edges(positions: np.ndarray, k: int) -> np.ndarray:
    if len(positions) < 2:
        return np.zeros((2, 0), dtype=np.int64)
    k_actual = min(k, len(positions) - 1)
    _, idx = KDTree(positions).query(positions, k=k_actual + 1)
    src, dst = [], []
    for i, neighbours in enumerate(idx):
        for j in neighbours:
            if i != j:
                src.append(i); dst.append(j)
    return np.array([src, dst], dtype=np.int64)


def _endpoint_edges(all_endpoints: list, tol: float) -> np.ndarray:
    pts, node_ids = [], []
    for node_idx, eps in enumerate(all_endpoints):
        for pt in eps:
            pts.append(pt); node_ids.append(node_idx)
    if len(pts) < 2:
        return np.zeros((2, 0), dtype=np.int64)
    pairs = KDTree(np.array(pts)).query_pairs(tol)
    seen, src, dst = set(), [], []
    for i, j in pairs:
        a, b = node_ids[i], node_ids[j]
        if a != b and (a, b) not in seen:
            src.extend([a, b]); dst.extend([b, a])
            seen.add((a, b)); seen.add((b, a))
    return np.array([src, dst], dtype=np.int64) if src else np.zeros((2, 0), dtype=np.int64)


def _text_edges(text_indices: list, geom_indices: list, positions: np.ndarray,
                k: int) -> np.ndarray:
    if not text_indices or not geom_indices:
        return np.zeros((2, 0), dtype=np.int64)
    geom_pos = positions[geom_indices]
    tree = KDTree(geom_pos)
    k_actual = min(k, len(geom_indices))
    src, dst = [], []
    for ti in text_indices:
        _, idx = tree.query(positions[ti], k=k_actual)
        if k_actual == 1:
            idx = [idx]
        for j in idx:
            gi = geom_indices[j]
            src.extend([ti, gi]); dst.extend([gi, ti])
    return np.array([src, dst], dtype=np.int64) if src else np.zeros((2, 0), dtype=np.int64)


def _edge_features(edge_index: np.ndarray, edge_types: np.ndarray,
                   positions: np.ndarray, directions: np.ndarray) -> np.ndarray:
    if edge_index.shape[1] == 0:
        return np.zeros((0, EDGE_DIM), dtype=np.float32)
    src, dst = edge_index[0], edge_index[1]
    diffs = positions[dst] - positions[src]
    dists = np.linalg.norm(diffs, axis=1)
    dist_norm = dists / max(dists.max(), 1e-6)
    dots = np.clip(np.sum(directions[src] * directions[dst], axis=1), -1, 1)
    angle = np.arccos(np.abs(dots)) / math.pi
    return np.stack([
        dist_norm, angle,
        (edge_types == 0).astype(np.float32),
        (edge_types == 1).astype(np.float32),
        (edge_types == 2).astype(np.float32),
    ], axis=1).astype(np.float32)


# -- Public: build graph -------------------------------------------------


def compute_transform(bounds: dict, img_h: int, img_w: int) -> dict | None:
    """Approximate DXF→pixel transform used by the training renderer.

    The renderer fits the drawing with ~10% padding preserving aspect ratio;
    this reproduces that fit so pixel features align with graph nodes.
    """
    dxf_w = bounds.get("width", 1)
    dxf_h = bounds.get("height", 1)
    if dxf_w < 1e-6 or dxf_h < 1e-6:
        return None
    avail_w = img_w * 0.9
    avail_h = img_h * 0.9
    scale = min(avail_w / dxf_w, avail_h / dxf_h)
    margin_x = (img_w - dxf_w * scale) / 2
    return {
        "scale": scale,
        "margin_px": int(margin_x),
        "canvas_h": img_h,
        "canvas_w": img_w,
        "dxf_min_x": bounds.get("min_x", 0),
        "dxf_min_y": bounds.get("min_y", 0),
        "dxf_width": dxf_w,
        "dxf_height": dxf_h,
    }


def dxf_to_enriched_graph(parsed: dict, image: np.ndarray, transform: dict,
                          knn_k: int = 8, endpoint_tol: float = 2.0,
                          text_k: int = 4) -> Data | None:
    """Build a 29-dim PyG graph for the GNN encoder (inference-only)."""
    bounds = parsed.get("bounds", {})
    if not bounds or bounds.get("width", 0) == 0:
        return None
    diag = math.hypot(bounds.get("width", 1), bounds.get("height", 1))

    geom_feats: list[np.ndarray] = []
    pix_feats: list[np.ndarray] = []
    positions: list[list[float]] = []
    directions: list[list[float]] = []
    endpoints: list[list] = []
    text_ids: list[int] = []
    geom_ids: list[int] = []
    node_idx = 0

    for entity in parsed.get("lines", []):
        geom_feats.append(_line_features(entity, bounds, diag))
        pix_feats.append(_pixel_features(entity, "lines", image, transform))
        cx = (entity["x1"] + entity["x2"]) / 2
        cy = (entity["y1"] + entity["y2"]) / 2
        dx, dy = entity["x2"] - entity["x1"], entity["y2"] - entity["y1"]
        length = max(math.hypot(dx, dy), 1e-6)
        positions.append([cx, cy])
        directions.append([dx / length, dy / length])
        endpoints.append(_line_endpoints(entity))
        geom_ids.append(node_idx); node_idx += 1

    for entity in parsed.get("arcs", []):
        geom_feats.append(_arc_features(entity, bounds, diag))
        pix_feats.append(np.zeros(NODE_DIM_PIXEL, dtype=np.float32))
        positions.append([entity["cx"], entity["cy"]])
        mid = math.radians((entity.get("start_angle", 0)
                            + entity.get("end_angle", 0)) / 2)
        directions.append([math.cos(mid), math.sin(mid)])
        endpoints.append(_arc_endpoints(entity))
        geom_ids.append(node_idx); node_idx += 1

    for entity in parsed.get("circles", []):
        geom_feats.append(_circle_features(entity, bounds, diag))
        pix_feats.append(np.zeros(NODE_DIM_PIXEL, dtype=np.float32))
        positions.append([entity["cx"], entity["cy"]])
        directions.append([0.0, 0.0])
        endpoints.append([])
        geom_ids.append(node_idx); node_idx += 1

    for entity in parsed.get("texts", []):
        geom_feats.append(_text_features(entity, bounds, diag))
        pix_feats.append(np.zeros(NODE_DIM_PIXEL, dtype=np.float32))
        positions.append([entity["x"], entity["y"]])
        directions.append([0.0, 0.0])
        endpoints.append([])
        text_ids.append(node_idx); node_idx += 1

    # Preserve the node ordering expected by _pairs.py: lines, arcs, circles, texts, dimensions.
    for entity in parsed.get("dimensions", []):
        geom_feats.append(_text_features(entity, bounds, diag))
        pix_feats.append(np.zeros(NODE_DIM_PIXEL, dtype=np.float32))
        positions.append([entity["x"], entity["y"]])
        directions.append([0.0, 0.0])
        endpoints.append([])
        text_ids.append(node_idx); node_idx += 1

    if not geom_feats:
        return None

    x = np.concatenate([np.stack(geom_feats), np.stack(pix_feats)], axis=1).astype(np.float32)
    positions_arr = np.array(positions)
    directions_arr = np.array(directions)

    knn = _knn_edges(positions_arr, knn_k)
    ep = _endpoint_edges(endpoints, endpoint_tol)
    tp = _text_edges(text_ids, geom_ids, positions_arr, text_k)
    edge_index = np.concatenate([knn, ep, tp], axis=1)
    edge_types = np.concatenate([
        np.zeros(knn.shape[1], dtype=np.int32),
        np.ones(ep.shape[1], dtype=np.int32),
        np.full(tp.shape[1], 2, dtype=np.int32),
    ])
    edge_attr = _edge_features(edge_index, edge_types, positions_arr, directions_arr)

    return Data(
        x=torch.from_numpy(x),
        edge_index=torch.from_numpy(edge_index),
        edge_attr=torch.from_numpy(edge_attr),
    )
