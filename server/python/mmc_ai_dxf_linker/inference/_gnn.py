"""Internal: GATv2 encoder and link-predictor nn.Modules.

Kept separate from the high-level ``LinkPredictor`` wrapper so that loading the
checkpoint only requires these small definitions.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch_geometric.nn import GATv2Conv


NODE_DIM_ENRICHED = 29  # geometry (16) + pixel intensity (13)
EDGE_DIM = 5
NUM_CLASSES = 6        # encoder classifier head is unused at inference
HIDDEN_CHANNELS = 64
HEADS = 2
NUM_LAYERS = 2
DROPOUT = 0.3


class DrawingGAT(nn.Module):
    """3-or-N-layer GATv2 encoder with skip connections and batch norm.

    The classifier head is only used during supervised pre-training of the
    encoder. At inference the link predictor calls :meth:`encode` which skips
    the head and returns node embeddings.
    """

    def __init__(
        self,
        in_channels: int = NODE_DIM_ENRICHED,
        hidden_channels: int = HIDDEN_CHANNELS,
        num_classes: int = NUM_CLASSES,
        num_layers: int = NUM_LAYERS,
        heads: int = HEADS,
        dropout: float = DROPOUT,
        edge_dim: int = EDGE_DIM,
    ):
        super().__init__()
        self.dropout = dropout
        self.num_layers = num_layers
        self.convs = nn.ModuleList()
        self.bns = nn.ModuleList()
        self.skips = nn.ModuleList()
        for i in range(num_layers):
            in_ch = in_channels if i == 0 else hidden_channels * heads
            h = 1 if i == num_layers - 1 else heads
            self.convs.append(GATv2Conv(
                in_ch, hidden_channels, heads=h,
                edge_dim=edge_dim, concat=True, dropout=dropout,
            ))
            self.bns.append(nn.BatchNorm1d(hidden_channels * h))
            if in_ch != hidden_channels * h:
                self.skips.append(nn.Linear(in_ch, hidden_channels * h))
            else:
                self.skips.append(nn.Identity())
        self.classifier = nn.Linear(hidden_channels, num_classes)

    def encode(self, x, edge_index, edge_attr=None):
        for i in range(self.num_layers):
            residual = self.skips[i](x)
            x = self.convs[i](x, edge_index, edge_attr=edge_attr)
            x = self.bns[i](x)
            x = x + residual
            if i < self.num_layers - 1:
                x = F.relu(x)
                x = F.dropout(x, p=self.dropout, training=self.training)
        return x

    def forward(self, x, edge_index, edge_attr=None):
        return self.classifier(self.encode(x, edge_index, edge_attr))


class LinkPredictorModule(nn.Module):
    """Scores (text, geometry) pairs using encoder embeddings + pair features.

    This is the raw nn.Module. Higher-level API lives in :mod:`link_predictor`.
    """

    def __init__(self, encoder: DrawingGAT, embed_dim: int = HIDDEN_CHANNELS,
                 hidden: int = 64, pair_dim: int = 5):
        super().__init__()
        self.encoder = encoder
        self.mlp = nn.Sequential(
            nn.Linear(embed_dim * 2 + pair_dim, hidden),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(hidden, 32),
            nn.ReLU(),
            nn.Linear(32, 1),
        )

    def forward(self, x, edge_index, edge_attr, text_idx, geom_idx,
                pair_features=None):
        emb = self.encoder.encode(x, edge_index, edge_attr)
        t = emb[text_idx]
        g = emb[geom_idx]
        if pair_features is None:
            pair_features = torch.zeros(len(text_idx), 5, device=x.device)
        return self.mlp(torch.cat([t, g, pair_features], dim=1)).squeeze(-1)
