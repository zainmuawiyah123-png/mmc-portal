# MMC – Vendor & Service Provider Registry

## Purpose
Build one central, reusable company profile for contractors, suppliers, manufacturers, equipment and machinery providers, consultants, and other service providers. The registry is a dedicated portal in the MMC ecosystem and a shared service for Procurement and Consultant workspaces.

## Canonical architecture
- Development base: `main` (the current Portal-1 code line).
- Working branch: `feature/mmc-vendor-service-provider-registry`.
- Do not merge or copy whole files from the separate VendorPanel or Consultant preview branches; those branches have independent histories and unrelated changes.
- Do not modify Portal-1 production or its database until the feature is tested and explicitly approved for release.
- Preserve existing procurement, consultant, contractor, subscription, and MMC AI routes and UI.

## Company profile (created once)
Required profile groups:
1. Legal identity: legal/trading names, country, registration number, tax number, legal address, website.
2. Classification: entity types (contractor, supplier, manufacturer, equipment/machinery provider, consultant, service provider), multiple disciplines, products, brands, services, capabilities, service regions.
3. Contacts: authorized contact, title, phone, official email, correspondence address.
4. Financial: bank name, account holder, account number, IBAN, SWIFT/BIC, currency, bank evidence. Financial fields are sensitive and must never appear in public directories or invitation browse results; return only to the company and explicitly authorized entity users.
5. Qualification documents: registration, professional licenses, contractor classification, engineering-office registration/classification, tax, insurance, quality/HSE, experience, project references, product certificates.
6. Provenance and audit: source type, source organization, source URL/reference, source verification date, profile update history.

## Separate status dimensions
- MMC profile: draft / submitted / verified / needs_update / rejected / suspended.
- Official source verification: unverified / matched / confirmed / expired / unavailable.
- Entity-specific qualification: pending / approved / conditionally_approved / rejected / suspended / expired.
- Subscription: independent commercial state; payment never grants professional or entity approval.

## Official directories and integrations
Support country-scoped source connectors for Contractors Associations/Syndicates, Engineers Syndicates and their engineering-consultancy office committees/directories, Chambers of Commerce/Industry, company registries, and other competent official registries.
Connector modes must include approved API, official data exchange, permitted directory lookup, and authorized periodic import. Do not scrape restricted sources or imply a live integration without an agreement/API. Store source attribution, retrieval time, source record key, and verification evidence.
Jordan is the first implementation country; design country adapters so additional countries can be added without schema changes.

## Procurement and Consultant permissions
- Only the owning Procurement organization or Consultant office can search/select vendors for its own tender/request, send invitations, request extra documents, review, approve, conditionally approve, reject, suspend, and evaluate.
- MMC Admin operates the platform, maintains source connectors and performs central profile verification; MMC Admin does not select invitees or decide tender awards.
- An entity may create a minimal vendor lead and send a registration invitation if the company is not yet registered.
- The company completes its central profile once. Each inviting entity may request additional entity-specific documents/answers and maintains its own approval, notes, evaluation and approved-vendor list.
- One entity's approval/rejection must not change another entity's approval state.
- Invitations must be tied to the inviting entity and the relevant tender/request; prevent cross-tenant access.

## Vendor portal
Dedicated entry: `/vendor-registry/`
Name: **MMC – Vendor & Service Provider Registry**
Capabilities: create/update central profile, manage contacts and classification, upload qualification documents, manage products/services, see official-source verification, respond to invitations, complete entity-specific questionnaires, and view entity-specific approval results.

## Procurement and Consultant portal additions
Each portal gets its own:
- Vendor / Contractor / Supplier / Service Provider registration and search
- Official directory search
- Invite new vendor
- Tender-specific invitation list and response status
- Entity-specific qualification checklist and documents
- Approved Vendors / Service Providers list
- Vendor evaluation history

Invitations and all tender-specific decisions remain exclusively with Procurement or Consultant.

## Data protection
- Never expose bank account/IBAN/SWIFT in public or general directory endpoints.
- Enforce tenant authorization on every entity-specific record and file download.
- Validate uploaded files, store outside public static directories, use private storage, audit sensitive access and changes.
- Do not copy association directory personal data into MMC without a permitted legal basis and source terms.
- Support consent/notice and correction requests where required.

## Subscription policy
Registration and central profile creation are separate from paid subscriptions. Basic registration and entity qualification do not automatically require an MMC subscription. Paid packages may unlock platform services, alerts, analytics, and workflow capabilities, but must not buy qualification, invitation priority, or tender awards.

## Delivery sequence
1. Inspect current main-branch auth, organization/consultant tenancy, storage, migration and portal patterns.
2. Add additive database schema and central registry API with tests.
3. Add entity-specific qualification and invitation APIs with tenant-isolation tests.
4. Add the dedicated bilingual Vendor Registry portal.
5. Add Procurement and Consultant UI entry points without replacing existing workflows.
6. Add official-directory connector framework; implement Jordan sources only where access is permitted and verifiable.
7. Deploy to a preview environment, run migrations/tests, validate workflows, then request approval before production release.

## Acceptance criteria
- A company creates one central profile and can be invited by multiple entities without duplicate core profiles.
- Each entity sees and controls only its own qualification records, invitations, notes and evaluations.
- Bank details are excluded from all directory, public and invitation-list responses.
- Procurement and Consultant can independently invite and approve suppliers, contractors and service providers.
- Official source records show attribution and verification status; no unsupported claim of live integration.
- Registration, entity approval and subscription are independent.
- Existing Portal-1 tender, billing, subscription and user data remain unchanged.
