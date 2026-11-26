# MMC AI Staging — PostgreSQL migration audit

Status: investigation only. This branch is not connected to a Render deployment.

## Verified current architecture

- The server opens SQLite directly through `better-sqlite3` in `server/src/db.js`.
- `getDB()` returns a synchronous better-sqlite3 connection; callers rely on synchronous `prepare()`, `get()`, `all()`, `run()`, and SQLite transaction behavior.
- `server/src/config.js` currently defines `DB_PATH` and has no PostgreSQL connection configuration.
- `server/src/migrate.js` owns the base schema and a sequence of additive upgrade functions. It uses SQLite-specific constructs including `PRAGMA`, `INTEGER` Unix timestamps, `unixepoch()`, `INSERT OR/ON CONFLICT`, `ALTER TABLE`, and SQLite table introspection.
- The migration file declares 88 application tables in its current schema/upgrade chain, spanning user/auth, procurement, consultant marketplace, MMC AI projects, drawings, takeoff, BOQ, scheduling, contracts/claims, BIM, Primavera/MS Project, and email verification.
- Existing email verification records live in `email_verifications`, keyed by `user_id`; resend depends on finding the corresponding user/verification state.
- The existing `migrate-to-cloud.js` is a file/object-storage migration, not a relational SQLite-to-PostgreSQL migration.

## Why a direct driver swap is unsafe

The application uses synchronous SQLite calls throughout routes and services. The PostgreSQL Node client is asynchronous. Replacing `better-sqlite3` with `pg` at the connection layer would break call sites and transaction semantics. SQLite SQL syntax, timestamp representation, booleans, row counts, conflict handling, and schema upgrades also need an explicit compatibility plan.

## Migration requirements

1. Inventory every SQL call site, prepared statement, transaction, and SQLite-only SQL expression.
2. Identify any recoverable SQLite database and its contents before changing the live service. Never overwrite or discard a possible source database.
3. Define PostgreSQL DDL for all 88 tables, constraints, indexes, foreign keys, and seed data.
4. Select an application migration approach:
   - preferred: asynchronous repository/data-access layer with explicit transaction APIs and staged conversion of callers; or
   - a proven compatibility adapter only if it faithfully supports the actual synchronous usage (do not assume one exists).
5. Add idempotent, versioned migrations and a repeatable import tool with row counts, checksums, FK validation, and rollback/retry handling.
6. Configure the Supabase connection only through Render's private environment settings; do not commit credentials.
7. Test registration, OTP resend/verify, review/approval, login, project/document access, takeoff, BOQ, schedule, and audit logging on an isolated staging deployment.
8. Preserve legal verification and admin approval gates. Email verification must not activate an account.
9. Do not change production, merge, or deploy without explicit approval.

## Current Supabase target

Existing project: `mmc-ai-storage` (project ref `ajnjwyrqcfwqwpnyfhgv`), region `eu-central-1`, status previously observed as ACTIVE_HEALTHY. At inspection time, `public` had no tables and there were no recorded migrations. No schema changes have been applied.

## Current blocker / evidence still needed

- No confirmed recoverable copy of the old SQLite file has been located yet.
- Full SQL call-site inventory and PostgreSQL DDL have not yet been completed.
- No database, application code, Render environment, or deployment has been modified by this audit.
