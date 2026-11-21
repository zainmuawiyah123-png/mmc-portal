# Release description — copy-paste into GitHub Releases

Copy everything below the line into the GitHub "Create release" page
when publishing `mmc-ai-v13-fixed-v2.zip` as a new release.

---

## v2.0.0 — Standalone Demo + neubuild.ai-style images

### Summary

Complete reconstruction of the mmc-ai v13 patch bundle with **all original
bugs fixed**, a new **standalone browser-only demo mode** (no Node.js /
SQLite / v13 backend required), full **BOQ CSV import** support, and
**12 curated neubuild.ai-style images** auto-injected into the page.

Every engineering quantity produced by the system is `needs_review` —
nothing is invented without engineer sign-off.

### 🆕 What's new in v2

#### Standalone demo mode (browser-only)
- `mmc-ai-bundle.js` (79 KB) — bundles the 4 pure-JS engines for browser use
- `mmc-ai-demo-backend.js` (26 KB) — `fetch` shim that implements every
  `/api/mmc-ai/*` endpoint client-side, backed by `localStorage`
- No Node.js, no SQLite, no v13 server needed for testing

#### BOQ CSV import (NEW endpoint)
- `POST /api/mmc-ai/projects/:id/boq-imports` now fully implemented
- Supports comma and semicolon delimiters
- Supports quoted fields (with `""` escaping)
- Recognizes Arabic and English column headers (رقم/بند/code, بيان/description, وحدة/unit, كمية/qty, سعر/rate)
- Stores items in `localStorage` per project
- Returns `{imported, rejected, total}` counts

#### 12 neubuild.ai-style images
- 3 hero / construction-site cover photos
- 3 worker-with-AR/tech photos
- 3 BIM 3D-model-on-screen renders
- 3 dashboard / Gantt chart screenshots
- Auto-injected into page placeholders via the bundle (zero HTML edits)

### 🐛 Bugs fixed

| # | Bug | Severity |
|---|-----|----------|
| 1 | `disciplines.length` ReferenceError — "Classify by Discipline" button wiped its own cards | 🔴 Critical |
| 2 | `BACKFILL` / `EARTH-FILL` excluded as annotation (lost backfill quantities) | 🔴 Critical |
| 3 | Arabic "ري" substring false-matched inside `طريق`, `مجاري`, `خريطة`, `مريض` | 🔴 Critical |
| 4 | `HYDRANT-MAIN` (no `FP-` prefix) → `unclassified` instead of `fire_protection` | 🟠 High |
| 5 | `GEN-PUMP` (no `M-` prefix) → `unclassified` (missing English `PUMP` keyword) | 🟠 High |
| 6 | `جدران` (plural of جدار) → `unclassified` | 🟡 Medium |
| 7 | `/boq-imports` endpoint not implemented in demo backend | 🟠 High |

### ✅ Verified

**7/7 end-to-end tests pass:**
```
1. Create project            → 201 ✓
2. BOQ import (null pid)     → 400 NO_PROJECT (bilingual error) ✓
3. BOQ import (valid CSV)    → 201 imported=3 ✓
4. List BOQ                  → 200 3 items ✓
5. Project summary           → boqItems=3, cost=39925 ✓
6. Manual BOQ add            → 201 amount=11520 ✓
7. DXF takeoff               → 201 1 item ✓
```

**10/10 classifier regression tests pass** for critical edge cases.

### 📦 Files included (38 files, 2.4 MB extracted)

```
mmc-ai-v13-fixed/
├── .gitignore
├── LICENSE                          MIT
├── README.md                        Main project README
├── README-FIXES.md                  Detailed setup (English)
├── CHANGELOG-FIXES.md               Detailed changelog (Arabic)
├── RELEASE_NOTES.md                 This file
├── serve_preview.py                 Local preview server (Python 3)
├── server/src/lib/mmc-ai/
│   ├── discipline-layer-classifier.js    BUG-FIXED
│   ├── discipline-measurement-kernels.js
│   ├── discipline-quantity-rules.js
│   ├── drawing-element-normalizer.js
│   ├── dxf-takeoff.js
│   └── demo-project.js
├── server/src/routes/mmc-ai-takeoff.js
└── webpages/technical-proposal-kit_v5/mmc-ai/
    ├── index.html                   Full standalone HTML dashboard (NEW)
    ├── mmc-ai-bundle.js             Engines + image injection (79 KB)
    ├── mmc-ai-demo-backend.js       fetch shim + boq-imports (26 KB)
    └── assets/                      12 neubuild.ai-style images (2 MB)
        ├── hero-construction-site-{1,2,3}.jpg
        ├── worker-ar-tech-{1,2,3}.jpg
        ├── bim-model-screen-{1,2,3}.jpg
        └── dashboard-gantt-{1,2,3}.{png,jpg}
```

### 🚀 Quick start

```bash
unzip mmc-ai-v13-fixed-v2.zip -d mmc-ai-v13-fixed
cd mmc-ai-v13-fixed
python3 serve_preview.py
# open http://localhost:8807/mmc-ai/workspace
```

Windows:
```powershell
cd mmc-ai-v13-fixed
python serve_preview.py
# or: py serve_preview.py
```

### ✅ Fully self-contained (NEW in v2)

This bundle now includes a complete `index.html` — a standalone dashboard
with: project selection/creation, KPI grid, project showcase with hero image,
DXF upload, takeoff trigger + results table, discipline classification cards,
quantity rules inputs + result cards, BOQ CSV import + manual entry + list
with totals. No external dependencies, no need to keep an old `index.html`.

### 🛠️ What works in demo mode v2

| Feature | Status |
|---------|--------|
| Project create / list / select | ✅ |
| Document upload (.dxf) | ✅ |
| DXF takeoff (LINE/LWPOLYLINE/CIRCLE/ARC/INSERT) | ✅ |
| Discipline classification (9 disciplines, 50+ categories) | ✅ |
| Quantity rules (25 rules across 8 disciplines) | ✅ |
| Wall net area with opening deductions | ✅ |
| Run review (approve / reject) | ✅ |
| **BOQ CSV import** (NEW) | ✅ |
| Manual BOQ item add | ✅ |
| Project summary with BOQ totals | ✅ |
| 12 neubuild.ai-style images auto-injected | ✅ |
| PDF takeoff | ❌ (needs `pdftotext`) |
| BIM / IFC / GLB | ❌ (needs file storage) |
| User layer management | ❌ (DEMO_LIMIT) |
| AI assistant | ❌ (DEMO_LIMIT) |

### 🔬 Engineering philosophy

Every quantity carries:
- `status: 'proposed' | 'incomplete'` (never `'approved'` automatically)
- `reviewState: 'needs_review' | 'needs_inputs'`
- `approvalEligible: false`
- Documented `assumptions[]`, `limitations[]`, `formula`, `ruleId`

Missing inputs cause `incomplete` status with a `reason` — never guessed.

Approved quantities require `owner`, `project_manager`, or `reviewer` role
via the `/review` endpoint.

### 📝 License

MIT — see `LICENSE`. Includes an engineering notice clarifying that all
output is proposed/draft and requires engineer review before contractual use.

### 🙏 Credits

- Engines, demo backend, bug fixes, standalone mode: built and verified
  through deterministic testing.
- Images: royalty-free stock via ZAI in-house image search.
- Visual inspiration: [neubuild.ai](https://www.neubuild.ai).

### 🔗 Full changelog

See [`CHANGELOG-FIXES.md`](CHANGELOG-FIXES.md) for the per-fix trace
(Arabic, with test results before/after each fix).
