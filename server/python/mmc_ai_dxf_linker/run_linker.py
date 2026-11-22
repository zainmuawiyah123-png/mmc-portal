#!/usr/bin/env python3
"""Experimental DXF dimension linker. Candidate associations only; never BOQ."""
import argparse, base64, json
from pathlib import Path
import cv2
from inference import LinkPredictor

HERE=Path(__file__).resolve().parent
def weights_path():
    target=HERE/'models'/'link_predictor_v1.pt'
    if not target.exists():
        encoded=(HERE/'models'/'link_predictor_v1.pt.b64').read_text()
        target.write_bytes(base64.b64decode(encoded))
    return target

p=argparse.ArgumentParser()
p.add_argument('--input',required=True)
p.add_argument('--image',required=True)
p.add_argument('--output',required=True)
p.add_argument('--threshold',type=float,default=0.5)
a=p.parse_args()
parsed=json.loads(Path(a.input).read_text(encoding='utf-8'))
image=cv2.imread(a.image,cv2.IMREAD_GRAYSCALE)
if image is None: raise SystemExit('Cannot read grayscale drawing image')
model=LinkPredictor.from_pretrained(weights_path(),device='cpu')
links=model.predict(parsed,image,score_threshold=a.threshold,top_k=1)
result={'engine':'occt-design-loop-link-predictor-v1','status':'candidate_links_only','quantityEligible':False,
'links':[{'dimensionNodeIndex':x.dim_idx,'geometryNodeIndex':x.geom_idx,'score':x.score,'normalizedDistance':x.distance_norm,'valueRatio':x.value_ratio} for x in links],
'limitations':['Candidate generation is heuristic-filtered before model scoring.','Links numeric dimension annotations to line/arc/circle geometry only.','Does not classify construction elements or calculate BOQ quantities.','Scores are not calibrated for MMC drawings; validate against real MMC DXFs.']}
Path(a.output).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
