# MMC AI Drawing Intelligence Engine — Implementation Plan v1

## Purpose

Build an in-platform drawing interpretation and quantity-measurement pipeline for MMC AI. The existing MMC AI platform, project model, authentication, document storage, BOQ workflow and user interface remain unchanged. Work is limited to the drawing-reading engine and its integration boundary.

Civils.ai is used only as a publicly observable product reference. No paid subscription, external upload, external API dependency or transfer of project drawings is part of this plan.

## Current implementation baseline

The current codebase already contains useful building blocks:
- PDF text extraction and OCR with word bounding boxes, page numbers and confidence.
- Conservative PDF drawing-text intelligence: title-block clues, scale text candidates, dimension callouts, discipline clues and cross-sheet references.
- DXF entity parsing and limited geometric measurements.
- Deterministic earthwork and concrete calculation kernels.
- Drawing element normalization, source provenance, review states and BOQ-related adapters.

These components do not yet form a verified PDF-to-quantity pipeline. OCR text candidates are not element geometry. A dimension label is not a calibrated scale. A DXF measurement is not proof of element classification. Existing calculation kernels require interpreted geometry as input.

## Target pipeline

1. **Document intake and page inventory** — preserve source document, revision and page identity; inventory page size, orientation, text layer and raster/vector characteristics; generate previews without modifying the original.
2. **PDF evidence extraction** — extract native PDF text with page coordinates; run OCR only where needed; extract vector primitives where available; keep text, OCR and vector evidence separate.
3. **Drawing sheet understanding** — identify title block, drawing number, revision, discipline, scale candidates, units, legends, schedules and detail/section references. Resolve cross-sheet references only when unique. Record conflicts.
4. **Coordinate and scale calibration** — establish page coordinates and transforms; calibrate only when an explicit dimension is associated with the corresponding geometry; support multiple viewports/scales; reject ambiguous calibration.
5. **Engineering element interpretation** — detect candidate boundaries, linework, symbols, contours, levels, sections and schedules; associate annotations with geometry; preserve confidence and unresolved reasons. Never invent hidden depth, material, reinforcement, soil class, specification or design intent.
6. **Discipline-specific measurement** — civil first: boundaries, cross-sections, chainages, levels, cut/fill areas and volumes. Concrete next: dimensioned footing, pedestal, column, beam and slab geometry. Reuse deterministic kernels only after geometry and units are verified.
7. **Traceable quantity records** — retain project/document/page/revision, source geometry and annotation IDs, coordinate system, scale evidence, dimensions, units, calculation rule/version/formula, confidence, warnings, assumptions and review state (initially needs_review).
8. **Visual verification and BOQ handoff** — overlay measured geometry on the source page; allow engineer inspection; only approved records may be offered to existing BOQ workflow; never overwrite manual BOQ items.

## First implementation slice

Implement a read-only PDF page evidence package before automatic takeoff: page inventory and stable page IDs; native text and OCR evidence with page-space bounding boxes; vector/raster availability indicators; explicit scale and dimension candidates with provenance; unresolved/conflict register; normalized page-coordinate contract.

This slice must not claim measured quantities. It establishes the evidence and coordinate foundation for later geometry interpretation.

## First real-drawing validation

Use the existing 266790015V4C.pdf only if it remains available in authorized project storage. Start with one selected civil sheet and one measurable feature. Do not upload the drawing to an external vendor.

1. Confirm page identity, page size and source revision.
2. Compare extracted dimensions and annotations with the visible sheet.
3. Confirm a known dimension maps to the correct geometric feature.
4. Calibrate the relevant viewport and report ambiguity.
5. Produce one measured geometry candidate with overlay and source reference.
6. Calculate only if geometry and method are supported.
7. Compare with an independent engineering takeoff and record variance.

If the PDF has no suitable civil feature or reliable scale, report the limitation and select another sheet. Do not manufacture a result.

## Acceptance gates

- **Gate A — Evidence:** page-specific text/OCR and source coordinates are saved and recoverable after refresh.
- **Gate B — Calibration:** identify the applicable viewport and scale, or explicitly refuse calibration.
- **Gate C — Geometry:** measured boundary/section is visible on an overlay and traceable to source page.
- **Gate D — Quantity:** one civil quantity is independently reproducible from recorded geometry and a named rule.
- **Gate E — BOQ:** only approved quantities can be handed to BOQ; existing manual BOQ data remains unchanged.

No gate is passed by a synthetic fixture alone. Synthetic tests provide regression coverage; real-drawing validation is mandatory.

## Safety and deployment constraints

- No production deployment as part of this work.
- No changes to production services, environment variables, storage configuration or user data.
- Do not delete or mutate MMC TEST PROJECT or its existing manual Excavation BOQ line (100 m³ × 3 JOD).
- Do not alter authentication, project membership, document upload, platform navigation or unrelated modules.
- All candidate quantities remain review-required until an authorized engineer approves them.
- New implementation must have automated tests and pass the existing MMC AI test suite before a staging deployment is proposed.

## Explicit non-goals

- Rebuilding MMC AI or changing its UI.
- Buying or subscribing to Civils.ai.
- Sending drawings to an external AI service.
- Claiming full automatic quantity surveying from OCR.
- Generating contractual quantities from ambiguous geometry.
- Enabling all disciplines before the civil pilot passes its acceptance gates.