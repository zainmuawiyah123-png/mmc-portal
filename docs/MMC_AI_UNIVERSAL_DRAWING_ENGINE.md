# MMC AI — Universal Drawing-to-BIM Engine

## Product contract

MMC AI is a project-wide drawing interpretation engine, not a per-drawing calculator. A drawing uploaded for the first time must pass through the same general pipeline regardless of project type. The engine must not require users to trace geometry, type dimensions, or select element-by-element quantities.

## Required pipeline

1. **Intake and integrity** — retain the original file, SHA-256, project, discipline (which may be unknown), sheet/revision metadata, and audit event.
2. **Format adapters** — PDF (text + vector + raster/OCR), raster images (PNG/JPG), exchange CAD (DXF), native CAD (DWG), and BIM exchange (IFC/GLB). An accepted upload is not evidence that the format has been interpreted.
3. **Sheet understanding** — page/sheet boundaries, title blocks, drawing number, revision, discipline, units, scale candidates, legends, dimensions, levels, symbols, schedules, detail bubbles, and cross-sheet references. Preserve source coordinates and confidence for every observation.
4. **Evidence graph** — link observations to source page, region, vector entity/OCR word box, revision, and related sheets. Resolve conflicts explicitly; do not silently choose a dimension.
5. **Geometry reconstruction** — build 2D plans/elevations/sections and connect them into 3D using verified scale, levels, dimensions, and cross-sheet evidence. Unsupported geometry remains unresolved; do not substitute generic boxes for unknown elements.
6. **Semantic BIM** — classify independently addressable elements by discipline, system, type, material/specification only when supported by evidence. Keep stable element IDs and source lineage.
7. **Quantity derivation** — produce discipline-specific quantity records with formula, inputs, units, rule/version, source references, overlap/void rules, and review state. No guessed dimensions, default heights, inferred material grades, or unverified scale.
8. **Coordination and QA** — detect missing sheets, conflicting dimensions/revisions, duplicate scope, geometry clashes, disconnected systems, and incomplete measurement evidence.
9. **Outputs** — navigable 3D model, IFC export with element classifications/properties, and draft BOQ grouped by compatible specification/unit/location. All outputs remain reviewable and traceable.

## Discipline coverage

- Structural: earthworks, foundations, concrete, formwork, reinforcement, structural steel, slabs, beams, columns, walls and stairs.
- Architectural: partitions, blockwork, doors, windows, finishes, ceilings, waterproofing and areas/lengths/counts.
- Electrical: containment, cable routes, trays, conduits, panels, devices, lighting and schedules.
- Mechanical/HVAC: equipment, ducts, fittings, terminals, pipework and schedules.
- Plumbing, drainage and fire protection: pipe routes, diameters, fittings, fixtures, equipment, slopes/levels and schedules.

A discipline can be marked not applicable only when the drawing set provides evidence for that decision; absence of an uploaded sheet is not proof of non-applicability.

## Mandatory states

Every extracted item and quantity must be one of: measured and ready for review; measured with incomplete evidence; conflict requiring resolution; not measurable because information is missing; or not applicable with evidence. "Approved" is reserved for an authorized human review.

## Acceptance gates (must pass on unseen drawings)

- A previously unseen, multi-sheet structural set: extract dimensions and schedules, construct traceable structural elements, calculate measurable quantities, and list omissions.
- A previously unseen architectural set: walls/openings/rooms/finishes with plan-to-section reconciliation and quantity derivations.
- A previously unseen MEP set: route and schedule extraction with diameters/sizes and measurable lengths/counts; no guessed routes.
- Scanned PDF and raster plan: OCR evidence retains word boxes and confidence; scale and geometry are not promoted until independently calibrated.
- Cross-sheet coordination: detail references, revisions, units and dimensions are reconciled; conflicts remain visible.
- IFC: exported file opens in an independent IFC viewer and contains separate elements, spatial hierarchy, units, classifications, properties, and quantity sets. A GLB mesh or renamed file is not an IFC deliverable.
- Regression: retain existing UI, auth, audit log, storage, and current project data. No production deployment until staging acceptance passes.

## Current code baseline — verified gaps

- PDF upload performs text/OCR and vector evidence collection, but the automatic reading result explicitly returns no quantities and no 3D model.
- OCR adapter currently accepts PDF only; PNG/JPG upload acceptance does not imply image analysis.
- PDF takeoff endpoint uses a narrow explicit structural schedule parser and rejects scanned/image-only PDFs rather than invoking OCR.
- DXF takeoff supports a limited ASCII entity set and reports unsupported geometry; DWG is not currently decoded by this route.
- Existing normalizer, sheet-reference resolver, measurement kernels, quantity-record contract, and BOQ compiler are useful building blocks, but they are not yet wired into one end-to-end general drawing pipeline.
- Existing 2D-to-3D reconstruction is limited to closed rectangular footprints with independently verified scale and height evidence; it is not yet general BIM reconstruction.
- Do not represent the current application as a completed universal drawing reader or professional IFC/BIM authoring system.

## Implementation order

1. Wire a single evidence-oriented pipeline orchestrator and common result schema across supported formats; make unsupported formats and runtime dependencies explicit.
2. Extend image OCR to PNG/JPG using the same word-box evidence contract; keep PDF text/vector/OCR evidence unified.
3. Add automatic scale calibration and dimension-to-geometry association with conflict detection.
4. Connect cross-sheet resolver, element normalizer, discipline kernels, quantity records, and BOQ compiler with source lineage.
5. Reconstruct non-rectangular and multi-view 3D elements, then classify into BIM entities.
6. Add IFC authoring/export and validate against an independent IFC parser/viewer.
7. Run unseen-drawing acceptance suites for all disciplines before deployment.

## Safety and engineering rules

- Never fabricate a quantity from a dimension label without identifying the measured element and its geometric basis.
- Never assume a default storey height, wall thickness, slab depth, bar anchorage, pipe route, or material.
- Distinguish gross, net, deducted openings, waste, laps, and overlaps explicitly.
- Preserve the source file and immutable evidence; all derived artifacts must be reproducible from source plus engine/rule version.
- Keep engineering review status visible and do not imply design approval.
