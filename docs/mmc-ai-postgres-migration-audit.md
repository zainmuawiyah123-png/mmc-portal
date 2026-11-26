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


## Additional runtime evidence (2026-11-26)

Render service metadata confirms:
- Service `mmc-ai-staging` is on the Free plan, in Frankfurt, with one instance.
- The service is currently configured to deploy from `mmc-bim-review-integration`.
- The latest successful deployment on 2026-11-26 started a new instance.
- Startup logs from that instance explicitly report: `[migrate] قاعدة البيانات: /tmp/mmc-ai-staging.db` and then list the schema tables and report migration success.

This is decisive evidence that the running service is currently opening SQLite at `/tmp/mmc-ai-staging.db`, not at a persistent mounted volume. A `/tmp` path is instance-local temporary storage and is not a safe database location for a service that can be redeployed or restarted. The latest logs show schema initialization, but do not by themselves prove the exact moment or cause that a particular registration row disappeared.

The resend handler's source confirms the user-facing message: it executes `SELECT id,email FROM users WHERE email=?` and returns `طلب التسجيل غير موجود.` when that query finds no row. Registration inserts the user and subscription transactionally before attempting OTP delivery. Therefore, the observed error means the database currently queried by the resend handler has no matching user row; it is not an SMTP/Resend delivery error.

### Immediate safe correction plan

- Do not ask the user to register again until persistence is corrected.
- Do not change the current service's database path blindly: the old temporary file may still be present in the running instance, and changing paths could make its records inaccessible. First take a safe copy/export of the current database if the platform permits it.
- Render service is Free and its current database path is `/tmp/mmc-ai-staging.db`. A persistent Render disk is not currently evidenced in service metadata; a paid disk would require explicit user approval.
- The existing Supabase Postgres project is a no-cost candidate within its current Free tier, but this app cannot switch to it by environment variable alone. A full staged data-layer migration remains necessary.
- Before implementing the PostgreSQL refactor, preserve a snapshot of any accessible SQLite database and establish a staging backup/restore test.


## Expanded source-code inventory (read-only audit)

The current source contains:
- 88 `CREATE TABLE IF NOT EXISTS` declarations.
- 98 `CREATE INDEX IF NOT EXISTS` declarations.
- 30 ordered upgrade functions in `server/src/migrate.js`.
- 19 occurrences of `PRAGMA`, 17 table-introspection uses of `PRAGMA table_info`, 20 `ALTER TABLE` statements, 118 uses of SQLite `unixepoch()`, and 2 references to `sqlite_master`.
- The migration module itself contains 52 `db.exec()`, 30 `db.prepare()`, and 3 `db.transaction()` calls.

The synchronous database API is not confined to authentication. It is used across the core procurement and finance routes, consultant marketplace, organization and verification flows, plus MMC AI projects, documents, takeoff, BOQ, schedule, BIM, risks, claims/contracts, Primavera P6, and MS Project. A staged conversion must cover these modules rather than only the OTP endpoints.

### Runtime service state rechecked

Render service metadata currently reports:
- Plan: `free`
- Region: `frankfurt`
- Runtime: Docker
- One instance
- Branch: `mmc-bim-review-integration`
- Auto deploy: `no`
- SSH address is exposed in service metadata, but the available Render connector has no shell/SSH execution or file-download operation.

The service's latest startup log identifies `/tmp/mmc-ai-staging.db` as the live database path. The metadata does not show an attached persistent disk. I have not attempted to create a cron job or a second service as a way to copy this file: a separate Render instance would have a different temporary filesystem and would not safely capture the running instance's SQLite file.

### Backup gate — do not proceed until resolved

The current connector cannot read or export the SQLite file from the running container. The old database may already have been lost by an instance replacement, but the logs alone cannot establish that. Before any database path or schema change:
1. Access the existing service instance through Render's own Shell/SSH facility, if available for this service.
2. Check whether `/tmp/mmc-ai-staging.db` exists and inspect its size and SQLite integrity.
3. If present, create a consistent SQLite backup using SQLite's backup mechanism (not a raw copy of a live WAL database), then transfer it securely off the instance.
4. If the file is absent or empty, record that fact and do not pretend that the earlier registration can be recovered.
5. Only then decide how to import recoverable records and how to switch the staging service to PostgreSQL.

### Migration architecture decision

A connection-string-only switch is ruled out. The current app has synchronous better-sqlite3 call sites in many modules. The safe long-term design is a staged asynchronous repository/data-access layer, beginning with authentication and email verification, then shared user/org/subscription functions, then procurement and MMC AI feature groups. Each stage needs tests and canary verification against a separate staging database. Keep SQLite tests available until feature parity is demonstrated.

Do not expose the application tables to the public Supabase Data API. The Node server should connect server-side using a private database connection string stored only in Render environment variables. No Supabase service-role or database password may be committed to the repository or exposed to browser code. RLS/grants must be designed explicitly if any tables are exposed later.

Supabase documentation checked for connection options confirms that direct Postgres connections suit long-lived backend services, while the shared session pooler is the IPv4 alternative; the transaction pooler does not support prepared statements. The existing Render service is in Frankfurt and Supabase is in eu-central-1, so the final connection method must be checked for network compatibility and latency before configuration. Free-tier Supabase projects should be backed up with regular logical exports; automatic daily backups are a paid-plan feature.


## Existing safe SQLite backup utility (verified in source)

The repository already contains `server/scripts/backup.js`. It uses SQLite `VACUUM INTO` rather than copying a live database file, runs `PRAGMA integrity_check`, compares row counts for its tracked tables, compresses the result, and records SHA-256 checksums. This is the preferred first capture method for the current running SQLite database.

Important limitation: the backup utility uploads off-instance only when `STORAGE_DRIVER=s3` and `BACKUP_UPLOAD=true`, with valid S3-compatible endpoint/bucket/credentials. Otherwise it leaves the backup under `BACKUP_DIR` on the same instance. The Dockerfile sets `BACKUP_DIR=/data/backups`, but the service currently has no confirmed persistent disk; a local backup alone is not a durable off-instance copy.

### Operator capture procedure (Render Shell, staging only)

1. Open the Shell for the existing `mmc-ai-staging` instance (do not create a new instance/service).
2. Run `cd /app/server && node scripts/backup.js --no-retention`.
3. Read the output carefully. A usable recovery capture requires a successful `integrity_check`, matching row counts, and a line confirming a cloud upload with checksum verification. If it says local-only, stop: the backup is still on the temporary instance and has not been secured off-instance.
4. Do not run restore, do not change `DB_PATH`, and do not redeploy during this capture.

This command does not change application data or replace the active database; it creates a backup. It may fail if the temporary filesystem has insufficient free space. The current connector does not provide Shell/SSH execution, so the command must be run by the account owner in Render's dashboard.

## Supabase target recheck (read-only)

As of this audit pass, project `ajnjwyrqcfwqwpnyfhgv` still reports no tables in `public`, no migration history, and no security/performance advisor lints. No SQL or schema changes have been made. Supabase's current docs confirm direct Postgres connectivity is intended for long-lived backends; the shared session pooler is the IPv4 alternative. Free-tier projects should be backed up with regular logical exports; automatic daily database backups are a paid-plan feature.

## Next implementation boundary

Do not begin the Postgres schema import until the live SQLite backup is verified off-instance. The initial code migration should be a separate PR and a dual-database staging branch, with a complete repository inventory and tests; it must not be deployed to the current Render service until the auth/OTP, organization/legal verification, subscriptions, procurement, file metadata, and MMC AI project/takeoff flows all pass against PostgreSQL. Preserve the current production/legal verification checks unchanged.
