# MMC AI — Comprehensive Project Quantity Surveying Specification

**Status:** Product and engineering requirements baseline  
**Applies to:** All project types, not only buildings  
**Principle:** MMC AI must discover and quantify the complete measurable scope of a project from its available design and contract information. It must not limit its scope to disciplines or line items explicitly named by a user.

## 1. Product objective

MMC AI is to become a multidisciplinary engineering quantity-surveying and BOQ production system. It must interpret drawings, schedules, specifications, models and other project records; identify construction and installation systems; derive measurable work items using discipline-appropriate rules; and produce an auditable, reviewable BOQ.

It is not sufficient to extract dimensions, areas, text or drawing geometry. A geometry or OCR result is evidence for engineering interpretation, not a completed quantity.

## 2. Project-type coverage

The system must support extensible work-breakdown templates for at least:

- Buildings: residential, commercial, institutional, healthcare and industrial.
- Industrial facilities: process plants, storage, utilities, foundations, equipment and pipe racks.
- Civil infrastructure: roads, highways, bridges, culverts, retaining structures and earthworks.
- Water and wastewater: networks, pumping stations, reservoirs, treatment facilities and drainage.
- Energy and utilities: substations, power distribution, renewable energy and utility corridors.
- Marine and heavy civil works: ports, waterfront structures, dikes, embankments and protection works.
- External works and landscaping.

A project may combine multiple types. Templates are starting taxonomies, not closed lists. The system must allow project-specific systems and BOQ sections to be added without code changes to the core measurement model.

## 3. Discipline coverage and discovery

The scope-discovery stage must inspect the complete available document set and determine which disciplines and systems are present, expected, missing or not applicable. It must not infer absence merely because the user did not mention a discipline.

### 3.1 General and enabling works
Mobilization, temporary facilities, access, surveys, setting out, protection, demolition, removals, temporary works, testing, commissioning, handover and as-built documentation where specified.

### 3.2 Earthworks and geotechnical
Site clearance, stripping, excavation by material/class and depth, trench and bulk excavation, shoring, dewatering, disposal and haulage, backfill, selected fill, replacement, imported material, compaction by layer, grading, subgrade preparation, ground improvement, piling platforms and erosion protection. Quantities must use levels, profiles, sections, geotechnical information and stated measurement rules.

### 3.3 Concrete and structural works
Blinding, plain and reinforced concrete, foundations, pile caps, piles, grade beams, columns, walls, beams, slabs, stairs, tanks, pits, culverts, precast elements, structural steel, connections, embeds, anchor bolts, formwork, reinforcement and protective systems. Reinforcement quantities must be derived from bar schedules/details or explicitly modelled design data, including bar marks, diameters, shapes, lengths, hooks, laps, couplers and bending allowances according to the specified standard. Do not estimate reinforcement from a generic kg/m³ factor where design data is required.

### 3.4 Architectural and finishes
Blockwork and masonry by type and thickness; partitions; plaster/render by substrate and finish; screeds; floor, wall and skirting finishes; stone and cladding; waterproofing and thermal/acoustic insulation; suspended ceilings; painting/coatings by system and number of coats; doors, windows, glazing, ironmongery, louvers, joinery, fixtures and fittings. Openings, reveals, returns, interfaces and finish extents must follow the governing measurement rules.

### 3.5 Electrical and ELV
Incoming supplies, transformers, generators, switchgear, distribution boards, breakers, busduct, containment, conduits, trunking, cable trays/ladders, cables and wires by type/size/core count, terminations, joints, earthing/bonding, lightning protection, lighting fixtures, controls, switches, sockets, emergency lighting, fire alarm, data/telecom, CCTV, access control, public address, security and other specified low-current systems. Cable and containment lengths must be traced from routes, risers, schematics and coordinated layouts; accessories and terminations must be counted by system rules.

### 3.6 Mechanical, HVAC and public health
HVAC equipment, chillers, pumps, AHUs, FCUs, fans, ductwork by dimensions/material/pressure class, insulation, dampers, grilles, diffusers, refrigerant and condensate pipework, controls, supports, testing and balancing. Domestic water, hot water, drainage, soil/waste/vent, stormwater, gas and specialist pipework must be quantified by material, diameter, class, route, fittings, valves, supports and accessories.

### 3.7 Fire protection and life safety
Fire pumps, tanks, sprinkler and standpipe networks, hydrants, hose reels, extinguishers, valves, fittings, pipe supports, fire alarm interfaces, smoke control and specified fire stopping. Include only systems required by the project documents and applicable design basis.

### 3.8 Other specialist systems
Lifts and escalators, façade access, BMS/controls, process equipment, compressed air, medical gases, industrial piping, instrumentation, roads and traffic systems, railway systems, irrigation, landscaping and any other project-specific package identified in the documents.

## 4. Required document intelligence

The ingestion and interpretation pipeline must catalogue and cross-reference:
- PDF vector and raster drawings, scanned drawings and OCR output.
- DWG/DXF and other supported CAD sources.
- BIM/IFC models and schedules where supplied.
- Specifications, general notes, design criteria and addenda.
- Structural reinforcement schedules and details.
- Door/window/finish/equipment schedules.
- Electrical single-line diagrams, schematics, panel schedules and layouts.
- Mechanical schematics, risers, equipment schedules and coordinated layouts.
- BOQs, scope documents, tender clarifications and revisions.

Every extracted fact must retain document ID, revision, sheet/page, drawing number, detail/section reference, coordinates or model element ID where available.

## 5. Canonical quantity item model

Each measurable item must contain, as applicable:

- Stable item ID and project/tenant ID.
- Work-breakdown path: project type, discipline, system, sub-system and work section.
- Standardized item description, specification and material/system attributes.
- Unit of measurement and measurement-rule identifier/version.
- Quantity, formula, operands, deductions/additions and rounding rule.
- Source document, revision, sheet/page, detail, zone/grid/level and element references.
- Derivation method: schedule, model takeoff, CAD geometry, route tracing, rule calculation or human input.
- Confidence/evidence state, assumptions, exclusions and unresolved dependencies.
- Duplicate/overlap group and interface ownership where trades intersect.
- Review state, reviewer, approval timestamp and full audit history.

Quantities must never be stored without provenance and a reproducible derivation record.

## 6. Measurement and calculation rules

Use discipline-specific rules and the project's specified standard of measurement (for example, the contract BOQ method or an explicitly selected measurement standard). Support configurable rules for deductions, openings, laps, waste, bulking/shrinkage, excavation classes, layer thicknesses, fittings, accessories, rounding and unit conversion.

Do not use a generic length × width calculation as the system's quantity-surveying method. Such a calculation may be one operand within a valid, fully defined engineering formula, but the item must be identified and measured according to its actual construction scope.

Examples:
- Excavation: derive volumes from existing/proposed levels, sections, profiles, footprint, side slopes, working space and material classes as applicable.
- Concrete: calculate individual structural element volumes from classified geometry and detail, accounting for intersections and voids under the selected measurement rules.
- Rebar: calculate bar-by-bar from schedules and reinforcement details, with bar shape, diameter, length, laps and weight basis recorded.
- Masonry: derive wall quantities from wall runs, heights, thicknesses, types and opening deductions under the selected rules.
- Electrical: derive cable and containment runs from coordinated routes and risers, then quantify cable types, cores, sizes, terminations and accessories.
- Mechanical/plumbing: derive pipe and duct runs from routed systems, classify by size/material/pressure or insulation class, and quantify fittings, valves, supports and equipment from schedules/details.

## 7. Coordination and duplicate prevention

A coordination layer must reconcile architectural, structural and MEP information. It must detect duplicate representation of the same physical scope, distinguish builder's work from supply/install scope, and assign clear ownership for sleeves, openings, embeds, supports, builders' work, equipment connections and fire stopping. It must flag unresolved clashes or scope boundaries rather than silently double-count or omit quantities.

## 8. Missing information and confidence policy

Use explicit states such as:
- **Measured — ready for review**
- **Measured — incomplete evidence**
- **Provisional — stated assumption**
- **Not measurable — required information missing**
- **Not applicable — supported by project evidence**
- **Conflict — drawings/specifications disagree**

Never fabricate dimensions, routes, reinforcement, material classes, equipment counts or specifications. When information is absent, list the exact missing drawing, schedule, dimension, level, route or design decision needed. A human may enter a provisional assumption, but it must be visible, attributable and excluded from approved totals until authorized.

## 9. BOQ output

Generate a unified BOQ with discipline and work-section summaries, item descriptions, units, quantities, measurement notes, source references, formula breakdowns, exclusions, provisional flags and revision history. Support mapping to client BOQ structures and export formats. Rates, resource build-ups, waste factors and pricing must remain separate from measured quantities and be traceable to their own sources.

## 10. Operational workflow

1. Register project type(s), location, contract measurement basis and document revisions.
2. Catalogue documents and detect disciplines/systems.
3. Produce a scope coverage matrix showing present, missing, expected and not-applicable packages.
4. Interpret drawings, schedules, specifications and models into classified elements and systems.
5. Run discipline-specific measurement engines.
6. Coordinate interfaces and remove duplicate scope.
7. Generate BOQ with formula and source traceability.
8. Run automated validation and completeness checks.
9. Route exceptions and quantities for human review and approval.
10. Freeze an approved measurement baseline; preserve revisions and change comparisons.

## 11. Acceptance criteria

The system is not considered a complete quantity-surveying capability until tests demonstrate that it can:
- Discover all represented disciplines in a mixed-discipline synthetic project without relying on a user-provided checklist.
- Produce known-reference quantities for earthworks, concrete, reinforcement, architectural finishes, electrical containment/cables, HVAC ductwork and pipework.
- Use schedules and details rather than only plan-view dimensions.
- Reconcile cross-discipline interfaces without duplicate counts.
- Explain every quantity with formula, unit, rule and source reference.
- Flag missing or contradictory design information instead of inventing a result.
- Preserve revision history and distinguish draft, provisional, reviewed and approved quantities.

## 12. Delivery strategy

Implement incrementally behind the existing MMC AI workflow:
1. Canonical element, source-evidence, quantity-derivation and scope-coverage data contracts.
2. Document catalogue and automatic discipline/system discovery.
3. Deterministic measurement engines with synthetic reference fixtures, beginning with well-defined geometry and schedules.
4. Trade-specific engines for earthworks, concrete/rebar, architecture, electrical, mechanical/HVAC, plumbing/drainage and fire protection.
5. Cross-trade coordination, BOQ mapping, validation and approval workflow.
6. Broader project-type templates and model/CAD integrations.

A discipline must be labelled supported only after its engine passes representative acceptance tests. Existing PDF preflight/text extraction must not be represented as engineering interpretation or quantity takeoff.
