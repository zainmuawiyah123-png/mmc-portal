# MMC experimental DXF dimension linker

Vendored from [OCCT Design Loop Models](https://github.com/gsdali/occt-design-loop-models), MIT License (2026, gsdali). Upstream license is included.

## Scope
Runs the upstream GATv2 link predictor for candidate associations between numeric dimension annotations and line/arc/circle geometry. It is **not** a drawing-understanding engine, does not identify slabs/beams/footings, and does not calculate concrete/rebar/excavation or BOQ quantities. Candidate pairs are first filtered heuristically by numeric value compatibility and spatial distance; model scores are not calibrated for MMC drawings.

## Run
Install into an isolated Python 3.11 environment with `pip install -r requirements.txt`, then:
```bash
python run_linker.py --input parsed-dxf.json --image drawing-gray.png --output associations.json
```
Input structure: `docs/input.schema.json`. The grayscale image must match DXF bounds and preserve aspect ratio with approximately 10% padding. Node ordering: lines, arcs, circles, texts, dimensions.

## Integration status
This is an isolated experimental bundle. It is not installed in the production Docker image, not called by the upload route, and does not create BOQ rows. Before enabling it, test on real MMC DXFs, validate render/coordinate alignment, measure precision/recall, and review CPU memory/build impact.
