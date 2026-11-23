# Database Migrations

How schema changes are made, applied and verified in MiniDrama.

Companion to [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md), which describes *what* the schema
contains. This document describes *how* it is allowed to change.

> **The one rule.** A migration that has been committed is never edited again.
> Everything else here follows from that. [§5](#5-why-existing-migrations-are-never-rewritten)
> explains why, and what to do instead.

---

## 1. The setup

| Thing | Where |
| --- | --- |
| Schema | `apps/backend/prisma/schema.prisma` |
| Migrations | `apps/backend/prisma/migrations/` |
| CLI config | `apps/backend/prisma.config.ts` |
| Seed | `apps/backend/prisma/seed.ts` |
| CI verification | `.github/workflows/ci.yml`, job `migrations` |
| Structural check | `apps/backend/scripts/verify-schema.ts` |

Prisma 7 with the `@prisma/adapter-pg` driver adapter ([ADR-17](DECISIONS.md)). There is no
`url` in the `datasource` block — the CLI reads `DATABASE_URL` through `prisma.config.ts`,
and the running application passes it to the adapter in `src/services/prisma.ts`. One
credential, two consumers, neither of them `schema.prisma`.

Migrations are **forward-only and additive** ([DATABASE_SCHEMA.md §8](DATABASE_SCHEMA.md)).
There is no down-migration and none is planned; a mistake is corrected by a new migration
that moves forward, not by reversing an old one.

### Current migrations

| Order | Name | Arrived with |
| --- | --- | --- |
| 1 | `20261115153845_init_catalogue_identity_engagement` | M1.3 |
| 2 | `20261116092214_add_playback_event_telemetry` | M2.4 |
| 3 | `20261117060610_add_auth_sessions_and_verification_tokens` | M2.5 |
| 4 | `20261118045211_add_account_deletion_audit` | M2.6 |

`migration_lock.toml` pins the provider to `postgresql`. It is committed and is not edited
by hand.

---

## 2. How a migration is created

Only ever on a developer's machine, against the local development database.

```bash
# From the repository root, with the database running:
docker compose up -d

# 1. Edit apps/backend/prisma/schema.prisma.

# 2. Generate the migration and apply it locally.
pnpm --filter @minidrama/backend db:migrate
```

`db:migrate` is `prisma migrate dev`. It diffs the schema against the database, writes a new
timestamped folder under `prisma/migrations/`, applies it, and regenerates the client. Prisma
prompts for a name — use the same style as the existing four: lower_snake_case, describing
what the migration *adds*, not which ticket asked for it.

Then, before committing:

```bash
# 3. Read the SQL it generated. Every line of it.
cat apps/backend/prisma/migrations/<new>/migration.sql

# 4. Confirm it applies to an empty database, exactly as CI will.
pnpm --filter @minidrama/backend test
```

Step 3 is not a formality. `migrate dev` generates SQL from a diff, and a diff has no idea
what the data means. A renamed column reliably comes out as `DROP COLUMN` + `ADD COLUMN` —
correct as a schema diff, total data loss as a migration. If the generated SQL would destroy
data, hand-write the SQL in that file **before it is committed**, while it is still yours to
change (see [§5](#5-why-existing-migrations-are-never-rewritten) for why "before it is
committed" is the operative phrase).

Step 4 works because the backend test harness applies every committed migration to a fresh
`minidrama_test` database on each run. It is the same check CI runs, four minutes earlier.

### Commands that must not be used to create one

| Command | Why not |
| --- | --- |
| `db:reset` (`prisma migrate reset`) | **Drops the database and reseeds it.** The most destructive command in the repo. It has a legitimate local use — rebuilding a development database that has drifted beyond repair — and no other. Never in CI, never against anything you are not willing to lose, never with a `DATABASE_URL` you have not read twice. |
| `prisma db push` | Applies the schema with no migration file at all. The database ends up correct and the repository ends up not knowing why. CI's drift check catches this on the next run. |

---

## 3. How migrations are applied

```bash
pnpm --filter @minidrama/backend db:migrate:deploy   # apply pending
pnpm --filter @minidrama/backend db:migrate:status   # what is applied
```

`migrate deploy` applies what is already in `prisma/migrations/` and **never authors one from
drift**. That distinction is the reason it, and not `migrate dev`, is what runs anywhere
other than a developer's own schema editing session:

- **CI** — `migrations` job, against an empty throwaway database.
- **The backend test suite** — `tests/support/test-database.ts`, against `minidrama_test`.
- **Production, when it exists** — as a deploy step, before the new version serves traffic.

A test run or a deployment must not be able to invent a migration. `deploy` cannot.

---

## 4. How empty-database verification works

The `migrations` job in `.github/workflows/ci.yml`. A `postgres:16-alpine` service container,
a database called `minidrama_ci_migrations` that was created seconds earlier and contains
nothing, and six steps:

1. **`db:verify -- --expect-empty`** — refuses to continue if the public schema already holds
   a table.
2. **`db:validate`** — `prisma validate`. The schema is syntactically and semantically sound.
3. **`db:migrate:deploy`** — every migration, in order, from empty. Fails on the first error.
4. **`db:migrate:status`** — all applied, none pending, none failed.
5. **`prisma migrate diff --exit-code`** — the drift check. See below.
6. **`db:generate`**, then **`db:verify`** — the client builds, and the structures are really
   there.

### Why step 1 exists

If this job is ever pointed at a database that already has the tables, `migrate deploy`
reports *"No pending migrations to apply"*, every subsequent step passes, and the job goes
green **having verified nothing at all**. A green run that tested nothing is worse than a red
one, because nobody investigates it. Step 1 makes that impossible. It only ever reads.

### Why step 5 is the important one

`prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --exit-code`
compares what the migrations actually built against what `schema.prisma` declares. Exit 0
means identical, exit 2 means drift, exit 1 means the command itself failed.

**Those are the Prisma 7 flag names.** Prisma 6 spelled them `--from-database-url <url>` and
`--to-schema-datamodel <path>`, which is what nearly every example online still shows;
passing those to Prisma 7 makes the CLI print its help and exit 1 — a broken step rather than
a failing check, but worth recognising on sight. `--from-config-datasource` takes the
connection string from `prisma.config.ts`, which also keeps the password off the command line
and out of the CI log.

It catches the two failures nothing else in the project would:

- A migration edited by hand until it no longer matches the schema.
- **A schema change committed without the migration that implements it.** This is the
  ordinary, easy mistake — you edit `schema.prisma`, run `db:generate`, everything typechecks,
  everything passes, and the migration folder was never created. Without this check it ships.

### What step 6 adds

`verify-schema.ts` queries `information_schema` and `pg_catalog` and asserts, in Postgres'
own vocabulary:

- Every `model` in the schema has a table, and there are no tables no model declares.
- Every `enum` exists as a Postgres type with **exactly** its declared labels — none missing,
  none extra.
- Every table has a primary key.
- Foreign keys exist, and there are at least as many unique indexes and plain indexes as the
  schema declares `@@unique` and `@@index`.
- Every row in `_prisma_migrations` finished and none was rolled back.

Its expectations are **parsed out of `schema.prisma` at run time, never hand-listed**. A
hand-maintained list of table names goes stale on the first migration nobody remembers to
update it for, and a stale allow-list that passes is worse than no check.

> **Uniqueness is counted as indexes, not constraints.** Prisma never emits
> `ADD CONSTRAINT ... UNIQUE`; every `@unique` and `@@unique` becomes a `CREATE UNIQUE INDEX`
> — 20 of them across the four committed migrations, and zero unique constraints. Postgres
> treats the two as different objects and only the constraint form appears in
> `information_schema.table_constraints`. A check that looks there reports zero against
> migrations that are perfectly correct, which is exactly what the first version of this
> script did.

This overlaps step 5 on purpose. Step 5 is the stronger assertion; step 6 is the one that
prints *"table Session does not exist"* instead of a Prisma-shaped datamodel diff, which is
the vocabulary you are already using when you are debugging it.

---

## 5. Why existing migrations are never rewritten

**A committed migration is immutable. This is not a style preference.**

Prisma records each applied migration in a `_prisma_migrations` table, together with a
checksum of its SQL. On every `migrate deploy` it compares the checksum of the file against
the one recorded when it was applied. Editing a migration that has already run anywhere
changes that checksum, and Prisma then refuses to proceed:

```
The migration `20261115153845_init_catalogue_identity_engagement` was modified
after it was applied.
```

Which is the *polite* failure. The real reasons are worse:

1. **It does not change any database where it already ran.** Your edit alters a file. The
   development database, every other developer's database, and production have all already
   executed the old version and moved on. You now have one SQL file describing a state that
   no live database is in.

2. **It makes history a lie.** The migration folder is a replayable record of how the schema
   reached its current shape. Edit one entry and it stops being replayable — a fresh database
   built from it ends up in a state no existing database was ever in, and the difference
   surfaces at the worst possible moment, which is the first deploy to the one environment
   you could not rebuild.

3. **A CI failure is not a reason.** This is the specific trap. The migration job goes red,
   and the fastest-looking fix is to edit the offending migration until it goes green. That
   converts a loud, local, cheap failure into a silent divergence between the repository and
   every database built before the edit. **If CI fails on a migration, the migration is
   information, not the problem.** Fix it forward.

### What to do instead

| Situation | Fix |
| --- | --- |
| The SQL is wrong and **not yet committed** | Edit it freely. Delete the folder, undo the schema change, re-run `db:migrate`. Nothing has run anywhere. |
| The SQL is wrong and **already committed** | Write a **new** migration that corrects it. `db:migrate` after fixing `schema.prisma`, then read the generated SQL. |
| CI reports drift | Something is in `schema.prisma` with no migration behind it, or vice versa. Run `db:migrate` locally to generate the missing one. Do not touch the existing four. |
| Local database is beyond repair | `db:reset`, locally, deliberately, having read §2. This is the only sanctioned use and it destroys your local data. |

---

## 6. Investigating a failed migration

**Read which step failed first.** They fail differently and the step name is the diagnosis.

| Failing step | What it means | Where to look |
| --- | --- | --- |
| `Confirm the database is empty` | The job was pointed at a database that already has tables. Verification would have been meaningless. | The `services.postgres` block, and `DATABASE_URL`. Nothing was dropped. |
| `Validate schema` | `schema.prisma` does not parse or is semantically invalid. Nothing touched the database. | The validator names the line. |
| `Apply all migrations` | A migration's SQL failed against Postgres. | **The first error in the log, not the last.** Everything after is fallout. |
| `Migration status` | Applied, but left in a failed or pending state. | A partially-applied migration — usually SQL that is not valid in one transaction. |
| `Check migrations reproduce schema.prisma` | **Drift.** The diff printed above the error is exactly what is missing. | Usually a schema edit with no migration. Generate one. |
| `Verify tables, enums, indexes and constraints` | A structure the schema declares is not in the database. | The script names it: which table, which enum, which label. |

### Reproducing locally

CI's environment is reproducible on a laptop in about a minute. Use a throwaway database —
never the development one:

```bash
# A scratch database on the local Postgres, created fresh.
export SCRATCH="postgresql://minidrama:<your-local-password>@localhost:55432/minidrama_scratch"

psql "${SCRATCH%/*}/postgres" -c 'DROP DATABASE IF EXISTS minidrama_scratch'
psql "${SCRATCH%/*}/postgres" -c 'CREATE DATABASE minidrama_scratch'

cd apps/backend
DATABASE_URL="$SCRATCH" pnpm run db:verify:empty
DATABASE_URL="$SCRATCH" pnpm run db:validate
DATABASE_URL="$SCRATCH" pnpm run db:migrate:deploy
DATABASE_URL="$SCRATCH" pnpm run db:migrate:status
DATABASE_URL="$SCRATCH" pnpm exec prisma migrate diff \
  --from-config-datasource \
  --to-schema=prisma/schema.prisma --exit-code
DATABASE_URL="$SCRATCH" pnpm run db:verify
```

Note the port: the development Postgres runs on whatever `POSTGRES_PORT` in the root `.env`
says, which on this project's machines is **not** always 5432 — a native Postgres commonly
owns that port already.

### Common causes

- **`type "X" already exists`** — two migrations both create the enum. The second needs to
  `ALTER TYPE ... ADD VALUE` instead.
- **`column "X" contains null values`** — a `NOT NULL` column added without a default to a
  table that has rows. Add with a default, backfill, then drop the default — three statements
  in one migration, or three migrations.
- **`cannot be executed within a transaction`** — some DDL, notably `CREATE INDEX
  CONCURRENTLY`, cannot run in Prisma's transaction. It needs its own migration.
- **Drift with an empty-looking diff** — usually a default or a constraint name that Prisma
  renders differently from how it was hand-written.

---

## 7. Why development and test databases stay isolated

**This cost real data once.** [ADR-30](DECISIONS.md) records it, and so does the comment block
at the top of `apps/backend/tests/support/test-database.ts`.

The first version of the test harness isolated itself by appending `?schema=minidrama_test` to
the development connection string — which is how Prisma isolates when it drives Postgres
through its own query engine. This project uses the **driver adapter** ([ADR-17](DECISIONS.md)),
and the adapter hands the connection string to `pg`, which does not understand `?schema=`.
Every "isolated" statement ran against `public`. The suite truncates between cases, so the
first full run emptied the development database.

The failure was silent. Nothing errored. The tests passed.

### What protects it now

Three guards, because one that can fail quietly is not a guard:

1. **A separate database, not a separate schema.** `minidrama_test`. `pg` connects to
   whatever is named in the path and there is no parameter for it to ignore.
2. **`assertIsTestDatabase()`** — refuses any URL whose database name is not exactly
   `minidrama_test`, before connecting.
3. **`SELECT current_database()` after connecting** — the harness asks Postgres what it is
   actually attached to and refuses to run on a mismatch. This is the check that would have
   caught the original bug on the very first run, rather than after it.

### And in CI

The guards are **not** bypassed in CI, and the job does not special-case itself. CI sets
`DATABASE_URL` to its service container's `minidrama` database and the harness derives
`minidrama_test` from it, exactly as it does on a laptop.

That is deliberate. The code that protects a developer's data should be the code that runs on
every pull request. A CI-only shortcut around it would mean the guards are least exercised in
the one place they are cheapest to test.

CI never reaches a development database. Its Postgres is a container on the runner's
loopback, created empty and destroyed with the VM, and the migration job uses a differently
named database (`minidrama_ci_migrations`) again so that a command copied from one job cannot
quietly land in the other.

---

## 8. Checklist for a schema change

- [ ] `schema.prisma` edited, with any departure from [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md)
      marked `DEVIATION:` and explained.
- [ ] `db:migrate` run locally; migration folder created.
- [ ] **Generated SQL read line by line.** No unintended `DROP`.
- [ ] `pnpm --filter @minidrama/backend test` passes — proves it applies from empty.
- [ ] `DATABASE_SCHEMA.md` updated.
- [ ] An ADR added if the change embodies a decision rather than an addition.
- [ ] No existing migration modified. Check with `git status`: the only file under
      `prisma/migrations/` in the diff should be the new one.
