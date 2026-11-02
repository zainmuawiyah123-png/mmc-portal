# MMC Tender Evaluation Engine — Implementation Contract

## Approved scoring policy
- Every tender publishes its technical criteria and criterion weights before submissions open.
- Criterion weights total 100.
- Each criterion is scored on a 0–100 scale.
- The weighted technical percentage is converted to the technical component: `technical_points = technical_score × 60 / 100`.
- Qualification requires at least 50/60. A score below 50/60 is technically disqualified and its financial offer remains locked.
- A qualified bidder's financial offer may be opened only after the technical result is recorded.
- The platform may calculate a financial comparison score under the tender's published financial method, but it does not automatically make the award decision. The issuing authority records the award decision and rationale.

## Integrity requirements
- Presence of a response is not proof of merit and must never produce a score by itself.
- Every score must be linked to a published criterion and supporting evidence.
- The exact criteria, weights, threshold, scoring rules, and engine version must be retained with the tender/submission evaluation so a later rules update cannot rewrite a historical result.
- A criterion that cannot be resolved objectively by the automated rules or document analysis must be marked for human review; the system must abstain rather than invent a score.
- Human scoring/overrides require a reason and append-only audit history.
- Financial amounts remain hidden until the technical qualification gate is passed.
- No evaluation rule or criterion may be changed after bid opening for that tender.

## Current development-branch changes
- Technical score and converted technical points are both returned and shown as /100 and /60.
- New submissions start at zero pending evaluation; merely entering text no longer grants 100 points.
- Financial offers remain locked until the technical qualification gate is passed.
- The scoring endpoint now requires a score for every published criterion and a written rationale.
- A non-destructive `bid_evaluation_audit` table records the scorer, criterion scores, reason, result, and timestamp.
- The procurement UI now provides criterion-level score inputs and a required rationale field.

## Important implementation boundary
The current scoring path is a controlled human-review fallback, not yet the requested automated-first engine. It deliberately does not claim that free-text answers can be judged objectively without a configured rubric or evidence extraction. The next implementation stage is:
1. Freeze a versioned criteria/rubric snapshot at publication.
2. Add criterion-level objective rule definitions (document type, required field, numeric limits, units, accepted evidence types, and pass/fail rules).
3. Add evidence records with document/page/paragraph references and extraction confidence.
4. Run deterministic rules first; use AI only for document classification and semantic evidence matching, with model/prompt/version traceability.
5. Auto-score only criteria whose evidence and rules meet the configured confidence threshold; abstain and route unresolved criteria to a reviewer.
6. Add regression tests for 49.99/60, 50/60, mandatory failures, missing evidence, changed rubric attempts, and financial-data isolation.

No production data or `main` branch is changed by this work. No deployment has been triggered.
