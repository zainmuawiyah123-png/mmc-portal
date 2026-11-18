# MMC AI — Construction Intelligence (v13, bug-fixed + standalone demo)

> Deterministic CAD/DXF takeoff + discipline classification + quantity rules
> for construction projects. Every output is `needs_review` — no quantities
> are invented without engineer sign-off.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: Demo](https://img.shields.io/badge/Status-Standalone%20Demo%20v2-brightgreen)](#standalone-demo-mode)
[![Engine: deterministic](https://img.shields.io/badge/Engine-deterministic%20JS-orange)](#engines)

---

## What this is

A patch bundle for an existing mmc-ai v13 server, plus a **standalone
browser-only demo mode** that runs the full takeoff pipeline without any
Node.js / SQLite / v13 backend.

| Layer | What it does |
|-------|-------------|
| **Engines** (pure JS, no Node APIs) | DXF geometry parsing, layer→discipline classification, engineering quantity rules |
| **Server route** (for v13 integration) | REST API: `/api/mmc-ai/projects/:id/documents/:docId/takeoff/dxf`, `/disciplines`, `/quantity-rules`, `/review`, etc. |
| **Standalone demo** (browser-only) | `fetch` shim that intercepts `/api/mmc-ai/*` calls and routes them to in-browser engines + localStorage |
| **Images** | 12 neubuild.ai-style royalty-free images auto-injected into page placeholders |

## Quick start (standalone demo mode)

```bash
# 1. Extract the zip
unzip mmc-ai-v13-fixed-v2.zip -d mmc-ai-v13-fixed
cd mmc-ai-v13-fixed

# 2. Run the local preview server (Python 3, no dependencies)
python3 serve_preview.py
# Windows: py serve_preview.py  (or python serve_preview.py)

# 3. Open in browser
# http://localhost:8807/mmc-ai/workspace
```

You'll see a green banner: "وضع تجريبي مستقل (Standalone Demo v2)".

### What works in demo mode

- ✅ Create / list / select projects (localStorage)
- ✅ Upload DXF files (in-memory)
- ✅ DXF takeoff: LINE / LWPOLYLINE / CIRCLE / ARC / INSERT (block expansion)
- ✅ Discipline classification: 9 disciplines, 50+ categories
- ✅ Quantity rules: 25 rules across 8 disciplines (walls, columns, beams,
  slabs, foundations, ducts, cables, pipes, sprinklers, hydrants, roads,
  excavation, trees, irrigation, etc.)
- ✅ Wall net area with opening deductions (with min-deduction threshold)
- ✅ Run review (approve / reject)
- ✅ **BOQ CSV import** — supports comma + semicolon, quoted fields,
  Arabic + English headers
- ✅ Manual BOQ item entry
- ✅ 12 neubuild.ai-style images auto-injected

### What does NOT work in demo mode

- ❌ PDF takeoff (needs `pdftotext` server-side)
- ❌ BIM / IFC / GLB upload (needs file storage)
- ❌ User layer management (POST/PATCH/DELETE on layers)
- ❌ AI assistant

These return clean JSON errors (`DEMO_LIMIT` / `DEMO_NOT_IMPLEMENTED`)
instead of crashing the page.

## Engines

| Module | Purpose | Lines |
|--------|---------|-------|
| `discipline-layer-classifier.js` | Maps CAD layer names → 9 disciplines + 50+ categories. AIA/NCS prefixes + Arabic/English keyword tables. | ~360 |
| `discipline-measurement-kernels.js` | Math kernels: masonry walls (with opening deductions), rectangular ductwork, routed services (pipes/cables). | ~110 |
| `discipline-quantity-rules.js` | 25 rules that convert classified CAD rows into *proposed* engineering quantities with explicit formulas + assumptions. | ~775 |
| `dxf-takeoff.js` | ASCII DXF parser: LINE / LWPOLYLINE / classic POLYLINE / CIRCLE / ARC / INSERT (with block expansion + transforms). $INSUNITS handling. | ~400 |
| `drawing-element-normalizer.js` | Converts measured primitives into traceable engineering candidates with explicit layer maps. | ~130 |
| `demo-project.js` | Illustrative demo BOQ + schedule + risks for first-time users. | ~85 |
| `mmc-ai-takeoff.js` | Express routes wiring the engines into the v13 REST API (with auth + audit + transactions). | ~230 |

## Bug fixes applied (vs upstream v13-improved-merge)

| # | Bug | Severity | Fix |
|---|-----|----------|-----|
| 1 | `disciplines.length` ReferenceError in UI button | 🔴 Critical | Use `data.disciplines.length` |
| 2 | BACKFILL / EARTH-FILL excluded as annotation | 🔴 Critical | Early backfill rule + `\bFILL\b` boundary |
| 3 | Arabic "ري" substring false matches (طريق, مجاري, خريطة, مريض) | 🔴 Critical | Removed bare "ري", added specific singulars |
| 4 | HYDRANT-MAIN → unclassified | 🟠 High | Added `HYDR` to fire_protection keyword |
| 5 | GEN-PUMP → unclassified | 🟠 High | Added English `PUMP` to mechanical keyword |
| 6 | جدران (plural) → unclassified | 🟡 Medium | Added plural form to walls + architectural |
| 7 | `/boq-imports` not implemented in demo backend | 🟠 High | NEW: full CSV parser + localStorage store |

See [`CHANGELOG-FIXES.md`](CHANGELOG-FIXES.md) for the full per-fix trace
(Arabic, with test results before/after).

## Project structure

```
mmc-ai-v13-fixed/
├── .gitignore
├── LICENSE                         ← MIT
├── README.md                       ← this file
├── README-FIXES.md                 ← detailed setup (English)
├── CHANGELOG-FIXES.md              ← detailed changelog (Arabic)
├── RELEASE_NOTES.md                ← copy-paste release description
├── serve_preview.py                ← local preview server
├── server/
│   └── src/
│       ├── lib/mmc-ai/
│       │   ├── discipline-layer-classifier.js    ← BUG-FIXED
│       │   ├── discipline-measurement-kernels.js
│       │   ├── discipline-quantity-rules.js
│       │   ├── drawing-element-normalizer.js
│       │   ├── dxf-takeoff.js
│       │   └── demo-project.js
│       └── routes/mmc-ai-takeoff.js
└── webpages/technical-proposal-kit_v5/mmc-ai/
    ├── index.html                  ← Full standalone dashboard (NEW)
    ├── mmc-ai-bundle.js            ← engines + image injection (auto-gen, 79 KB)
    ├── mmc-ai-demo-backend.js      ← fetch shim + boq-imports (26 KB)
    └── assets/                     ← 12 neubuild.ai-style images (2 MB)
        ├── hero-construction-site-{1,2,3}.jpg
        ├── worker-ar-tech-{1,2,3}.jpg
        ├── bim-model-screen-{1,2,3}.jpg
        └── dashboard-gantt-{1,2,3}.{png,jpg}
```

## Deployment

### Option A — Use as a patch on existing v13 server

Copy the server-side files over your v13 installation:

```bash
cp server/src/lib/mmc-ai/discipline-layer-classifier.js  /path/to/v13/server/src/lib/mmc-ai/
cp server/src/lib/mmc-ai/discipline-quantity-rules.js     /path/to/v13/server/src/lib/mmc-ai/
# ... etc for the other engine files
cp server/src/routes/mmc-ai-takeoff.js                    /path/to/v13/server/src/routes/
```

Restart the v13 server. No DB migration needed.

### Option B — Standalone demo mode (no backend)

See [Quick start](#quick-start-standalone-demo-mode) above.

### Option C — Publish to GitHub

1. Create a new repo (or use an existing one)
2. Push the entire `mmc-ai-v13-fixed/` folder
3. Tag a release using the description in `RELEASE_NOTES.md`

## Verification

7/7 end-to-end tests pass under a Node-simulated browser environment:

```
1. Create project            → 201 ✓
2. BOQ import (null pid)     → 400 NO_PROJECT (bilingual) ✓
3. BOQ import (valid CSV)    → 201 imported=3 ✓
4. List BOQ                  → 200 3 items ✓
5. Project summary           → boqItems=3, cost=39925 ✓
6. Manual BOQ add            → 201 amount=11520 ✓
7. DXF takeoff               → 201 1 item ✓
```

Classifier regression tests: 10/10 critical edge cases pass
(BACKFILL, EARTH-FILL, HYDRANT-MAIN, HYDRANT-F1, GEN-PUMP, مجاري,
طريق, جدران, خريطة, مريض).

## Engineering philosophy

Every quantity produced by this system carries:

- `status: 'proposed' | 'incomplete'` (never `'approved'` automatically)
- `reviewState: 'needs_review' | 'needs_inputs'`
- `approvalEligible: false`
- An `assumptions[]` array documenting every input and inference
- A `limitations[]` array listing what was NOT included
- A `formula` string showing the math applied
- A `ruleId` linking back to the rule that produced it

Missing inputs (height, thickness, diameter, typical door sizes) cause the
output to be `incomplete` with a `reason` — never guessed.

Approved quantities can only come from the `/review` endpoint, which
requires `owner`, `project_manager`, or `reviewer` role.

## License

MIT — see [`LICENSE`](LICENSE). The engineering notice in the license
clarifies that all output is proposed/draft and requires engineer review
before contractual use.

## Credits

- Engines, demo backend, bug fixes, standalone mode: built and verified
  through deterministic testing.
- Images: royalty-free stock via ZAI in-house image search (Shutterstock,
  Alamy, LinkedIn, Milwaukee Tool, Strand Consulting, W. Bradley Electric,
  Powerslides, Lark, Wrike, Economic Times).
- Inspired by [neubuild.ai](https://www.neubuild.ai) visual style for
  construction-intelligence SaaS.
