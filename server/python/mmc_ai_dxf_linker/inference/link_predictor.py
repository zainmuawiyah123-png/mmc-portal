"""High-level inference API for the GATv2 link predictor.

Example::

    from inference import LinkPredictor
    import cv2, json

    model = LinkPredictor.from_pretrained("models/link_predictor_v1.pt")
    parsed = json.load(open("sample.json"))
    image = cv2.imread("sample.png", cv2.IMREAD_GRAYSCALE)
    links = model.predict(parsed, image)
    for a in links:
        print(a.dim_idx, a.geom_idx, f"{a.score:.3f}")
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

from ._gnn import (
    DrawingGAT, LinkPredictorModule,
    NODE_DIM_ENRICHED, NUM_CLASSES, EDGE_DIM,
    HIDDEN_CHANNELS, NUM_LAYERS, HEADS, DROPOUT,
)
from ._graph import compute_transform, dxf_to_enriched_graph
from ._pairs import build_link_pairs


@dataclass
class Association:
    """A single predicted (dimension-text, geometry) link."""

    dim_idx: int    # node index into parsed (lines+arcs+circles+texts+dimensions)
    geom_idx: int   # same indexing; always a geometry entity
    score: float    # calibrated probability in [0, 1]
    distance_norm: float
    value_ratio: float


class LinkPredictor:
    """Wrap the trained GATv2 link predictor for dimension-geometry association.

    Parameters
    ----------
    checkpoint_path : path to ``link_predictor_vN.pt``.
    encoder_path : path to the encoder weights (``gnn_encoder_vN.pt``). The
        encoder sub-module is overwritten by the link predictor checkpoint
        anyway, so this only has to be a matching architecture — any encoder
        with the right dims will do.
    calibration_path : optional Platt scaling ``(slope, intercept)`` so that
        raw logits become meaningful probabilities. Without it, ranking is
        correct but absolute thresholds are unreliable.
    device : ``"cpu"``, ``"mps"`` or ``"cuda"``.
    """

    def __init__(
        self,
        model: LinkPredictorModule,
        *,
        calibration: dict | None = None,
        device: str = "cpu",
    ):
        self.model = model.eval()
        self.calibration = calibration
        self.device = torch.device(device)
        self.model.to(self.device)

    @classmethod
    def from_pretrained(
        cls,
        checkpoint_path: str | Path,
        calibration_path: str | Path | None = None,
        device: str = "cpu",
    ) -> "LinkPredictor":
        """Load a fine-tuned link predictor (encoder + MLP head in one file)."""
        ckpt = Path(checkpoint_path)
        encoder = DrawingGAT(
            in_channels=NODE_DIM_ENRICHED,
            hidden_channels=HIDDEN_CHANNELS,
            num_classes=NUM_CLASSES,
            num_layers=NUM_LAYERS,
            heads=HEADS,
            dropout=DROPOUT,
            edge_dim=EDGE_DIM,
        )
        model = LinkPredictorModule(encoder, embed_dim=HIDDEN_CHANNELS)
        state = torch.load(ckpt, map_location="cpu", weights_only=True)
        model.load_state_dict(state)

        calibration = None
        if calibration_path is not None:
            payload = json.loads(Path(calibration_path).read_text())
            if "slope" in payload and "intercept" in payload:
                calibration = {"slope": float(payload["slope"]),
                               "intercept": float(payload["intercept"])}
        return cls(model, calibration=calibration, device=device)

    @torch.no_grad()
    def predict(
        self,
        parsed: dict,
        image: np.ndarray,
        *,
        score_threshold: float = 0.5,
        top_k: int | None = 1,
    ) -> list[Association]:
        """Return candidate (dimension-text, geometry) links sorted by score.

        Parameters
        ----------
        parsed : parsed-DXF dict (see ``data_format/graph_format.md``).
        image : grayscale raster with the drawing rendered to the same bounds.
            The GNN uses pixel-intensity features for line-style cues; without
            a matching raster it cannot distinguish dashed/solid lines.
        score_threshold : drop pairs below this calibrated probability.
        top_k : if set, keep only the top-``k`` geometries per text node.
        """
        bounds = parsed.get("bounds", {})
        if not bounds or bounds.get("width", 0) < 1:
            return []
        h, w = image.shape[:2]
        transform = compute_transform(bounds, h, w)
        if transform is None:
            return []
        graph = dxf_to_enriched_graph(parsed, image, transform)
        if graph is None or graph.x.shape[0] < 2:
            return []
        link_data = build_link_pairs(parsed)
        if link_data is None:
            return []
        pairs = link_data["positive_pairs"] + link_data["negative_pairs"]
        if not pairs:
            return []

        text_idx = torch.tensor([p["text_idx"] for p in pairs], dtype=torch.long)
        geom_idx = torch.tensor([p["geom_idx"] for p in pairs], dtype=torch.long)
        pair_feat = torch.tensor(
            [[p["distance"], p["value_ratio"], 0, 0, 0] for p in pairs],
            dtype=torch.float,
        )
        # Clamp to graph size — build_link_pairs may reference nodes that got
        # filtered out if the graph drops any.
        max_idx = graph.x.shape[0]
        valid = (text_idx < max_idx) & (geom_idx < max_idx)
        text_idx = text_idx[valid]
        geom_idx = geom_idx[valid]
        pair_feat = pair_feat[valid]
        if len(text_idx) == 0:
            return []
        pairs = [p for p, v in zip(pairs, valid.tolist()) if v]

        logits = self.model(
            graph.x.to(self.device),
            graph.edge_index.to(self.device),
            graph.edge_attr.to(self.device),
            text_idx.to(self.device),
            geom_idx.to(self.device),
            pair_feat.to(self.device),
        )
        if self.calibration is not None:
            logits = logits * self.calibration["slope"] + self.calibration["intercept"]
        scores = torch.sigmoid(logits).cpu().numpy()

        ranked: list[tuple[float, dict]] = sorted(
            ((float(s), p) for s, p in zip(scores, pairs) if s >= score_threshold),
            key=lambda item: -item[0],
        )

        if top_k is not None:
            per_text: dict[int, int] = {}
            trimmed = []
            for s, p in ranked:
                tx = int(p["text_idx"])
                if per_text.get(tx, 0) >= top_k:
                    continue
                per_text[tx] = per_text.get(tx, 0) + 1
                trimmed.append((s, p))
            ranked = trimmed

        return [
            Association(
                dim_idx=int(p["text_idx"]),
                geom_idx=int(p["geom_idx"]),
                score=float(s),
                distance_norm=float(p["distance"]),
                value_ratio=float(p["value_ratio"]),
            )
            for s, p in ranked
        ]
