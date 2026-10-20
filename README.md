<img src="assets/wireframe-mesh.svg" alt="Abstract dark wireframe mesh: glowing connected nodes over a perspective grid" width="100%" />

# Susu Protocol — API

[![CI](https://github.com/susu-labs/susu-api/actions/workflows/ci.yml/badge.svg)](https://github.com/susu-labs/susu-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status: Testnet · reviewed](https://img.shields.io/badge/status-testnet%20%C2%B7%20reviewed-orange.svg)](#project-status)
[![Mainnet: readiness implemented · deployment gated](https://img.shields.io/badge/mainnet-readiness%20implemented%20%C2%B7%20deployment%20gated-yellow.svg)](#project-status)

Backend API for **Susu Protocol** — a non-custodial rotating savings protocol on Stellar.

It serves the read model over the indexer's chain-derived tables, and owns accounts, sessions,
wallet linking, invites, notifications, avatar metadata, and transaction preparation. It is an
**application layer only**: it holds no key, signs nothing, and can be deleted without affecting a
single balance.

> **Reviewed by the maintainer, and not independently audited.** It runs against Stellar Testnet.
> Mainnet readiness is implemented and mechanically verified, but deployment is deliberately gated
> until the attestations are satisfied. Read [Project status](#project-status) before you read
> anything else.

---

## The system

Susu is four repositories. This one serves the read model and the application layer.

| Repository | Responsibility | Runs on |
| --- | --- | --- |
| [`susu-contracts`](https://github.com/susu-labs/susu-contracts) | Soroban contracts. The financial authority. | **Testnet** |
| [`susu-indexer`](https://github.com/susu-labs/susu-indexer) | Reads chain events, records them in Postgres on a schedule. | **Testnet** (Supabase Cron) |
| **`susu-api`** *(you are here)* | Read model, accounts, invites, notifications, transaction preparation. | Local |
| [`susu-web`](https://github.com/susu-labs/susu-web) | The client. | Local |

If database state ever conflicts with Stellar/Soroban state, **the chain wins** and this service is
wrong.

## Project status

**Testnet. Reviewed by the maintainer. Mainnet readiness implemented — deployment gated on attestations.**

All twelve planned build phases are implemented, and every endpoint below is covered by tests. The
chain-derived read surface, accounts and sessions, wallet linking, invites, notifications,
avatars, and transaction preparation are all in place.

This service is **not hosted anywhere** — there is no deployment configuration in this repository,
and it is run locally against the hosted Testnet database. Hosting it is a deployment decision that
has not been made, and it is not on the critical path: the contracts and the indexer are the parts
that must be live, and the client talks to the chain directly for anything that matters.

Two gates stand between this and Mainnet. The machinery for both is written; neither is satisfied:

| Gate | State |
| --- | --- |
| **Independent security review** | **Not commissioned. The maintainer has reviewed this code, which is a different claim.** See [`susu-contracts/docs/AUDIT_SCOPE.md`](https://github.com/susu-labs/susu-contracts/blob/main/docs/AUDIT_SCOPE.md). |
| **Mainnet readiness** | **Implemented and mechanically verified; `NO-GO` until the attestations are satisfied.** See [`susu-contracts/docs/MAINNET_READINESS.md`](https://github.com/susu-labs/susu-contracts/blob/main/docs/MAINNET_READINESS.md). |

## Contents

- [This service is not a custodian](#this-service-is-not-a-custodian)
- [Stack](#stack)
- [Endpoints](#endpoints)
- [When redeeming an invite does not spend a use](#when-redeeming-an-invite-does-not-spend-a-use)
- [Why `GET /api/v1/me/activity` exists next to the per-group activity list](#why-get-apiv1meactivity-exists-next-to-the-per-group-activity-list)
- [Notifications, and who derives them](#notifications-and-who-derives-them)
- [Profile images, and who can touch them](#profile-images-and-who-can-touch-them)
- [Why `POST /api/v1/transactions/prepare` exists and cannot move money](#why-post-apiv1transactionsprepare-exists-and-cannot-move-money)
- [Why `POST /api/v1/groups` exists and does not create a group](#why-post-apiv1groups-exists-and-does-not-create-a-group)
- [The read model](#the-read-model)
- [Security controls](#security-controls)
- [Dependencies](#dependencies)
- [Database security](#database-security)
- [Connecting to a hosted database](#connecting-to-a-hosted-database)
- [Development](#development)
- [Checks](#checks)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## This service is not a custodian

The API is an **application layer only**. It may handle sessions, profiles, invites,
notifications, read APIs, transaction preparation, indexing, reconciliation, and rate
limiting.

It may **not** decide balances, payout recipients, eligibility, or financial
authorization, and it may **not** override contract state. If database state ever conflicts
with Stellar/Soroban state, **the chain wins** and reconciliation repairs the database.

## Stack

Node.js · TypeScript · Fastify · Zod · Drizzle ORM · PostgreSQL (Supabase) · Stellar SDK

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness. Does no I/O. |
| `GET` | `/ready` | Readiness, including a database probe. |
| `GET` | `/api/v1/groups` | List groups. Filters: `status`, `creator`, `member`. |
| `GET` | `/api/v1/groups/:contractId` | One group, with its members and per-round summary. |
| `GET` | `/api/v1/groups/:contractId/contributions` | Contributions, in round then ledger order. |
| `GET` | `/api/v1/groups/:contractId/payouts` | Payouts, net of the protocol fee. |
| `GET` | `/api/v1/groups/:contractId/activity` | Every decoded event, as the audit trail. |
| `POST` | `/api/v1/groups` | Records a group address the chain has just produced, for a bounded window. See below. |
| `GET` | `/api/v1/transactions/:txHash` | The decoded receipt for one transaction. Public. |
| `POST` | `/api/v1/transactions/prepare` | Simulates one contract invocation and returns it with a footprint and fee. Authenticated. See below. |
| `GET` | `/api/v1/me/activity` | Every decoded event from every group the caller's wallet is in, newest first. Authenticated. See below. |

Lists are paginated with `limit` (default 20, max 100) and `offset` (max 10000), and
return `{ data, page: { limit, offset, hasMore } }`.

Filtering by `member` is how a wallet's groups are read — there is no separate
wallet endpoint, because the answer is the same list under a different filter.

The account surface is `GET`, `PATCH` and `DELETE /api/v1/me`; wallet linking is
`POST /api/v1/wallet/nonce` then `POST /api/v1/wallet/verify`; invites are created with
`POST /api/v1/groups/:contractId/invites` and redeemed with `POST /api/v1/invites/redeem`
(codes are opaque, so the client learns the group from the response) or
`POST /api/v1/groups/:contractId/join` when the client already knows it; notifications are
`GET /api/v1/notifications` and `POST /api/v1/notifications/:id/read`.

## When redeeming an invite does not spend a use

A code outlives the window it was made for. A group opens, fills up, and someone calls
`start`; the link keeps circulating. The chain refuses a join unless the group is still
`open`, so redeeming such a code used to consume a use and only then let the client discover,
on its first read of the group, that joining had never been possible.

Now it resolves without consuming: the response still names the group — the client needs the
address to explain *why*, and "this group has already started" is a better answer than "that
code is no good" — and nothing is written. No use, and no redemption row that would make the
visitor look like an existing member.

Two properties keep this safe. The answer comes from the read model and can be stale by one
indexer run, so it is only ever allowed to **withhold** a claim and never to grant a join; the
chain decides that. And an unknown group is treated as claimable, not as closed: a group whose
creator has just registered it and whose indexer run has not happened yet is exactly the case
this must not break. Idempotence also outranks it — a member who already redeemed is reported
as such without asking, because their use was spent legitimately and the invite is still
theirs.

## Why `GET /api/v1/me/activity` exists next to the per-group activity list

A group's activity list answers "how did this group get here" and is read oldest-first. The
feed answers "what just happened to me" and is read newest-first, across every group the
caller's **linked wallet** belongs to. It is one query rather than one request per group,
and membership is matched in SQL against the address the session is bound to — the caller
cannot name an address, and an address in no group gets an empty page rather than an error.

An account with no linked wallet gets an empty feed for the same reason: membership is by
wallet, so there is provably nothing to show, and `GET /api/v1/me` already reports
`walletAddress: null` for the client to explain it with.

## Notifications, and who derives them

A notification is not authored, it is **derived**: "your payout was confirmed" is a statement
about one decoded chain event. The derivation is `public.derive_notifications()`, defined in
`drizzle/0006_notification_schedule.sql` and revised in `drizzle/0007_notification_order.sql`,
and scheduled with `pg_cron` to run every minute. It
lives in SQL rather than here because it is one set-based statement and because Postgres can
run it without this service being reachable or authenticated; `createNotificationSweeper` is a
thin caller for triggering it from the application, not a second implementation.

The API does **not** start that caller on boot, and that is deliberate: the schedule belongs to
`pg_cron`, so derivation continues when this service is down, and a second trigger inside the
service would only add a way for the two to disagree about when the work happened. The sweeper is
for running it by hand while investigating, and for deployments with no `pg_cron`.

The chain has never heard of a user — it knows wallet addresses — so turning events into
messages needs `wallet_links`. That is why the indexer does not do it: it writes the faithful
record, and this is a separate step over the same source. **Notifications are therefore never
authoritative.** A member who wants to know whether they were paid reads the contract; a
notification that never arrived costs them a look rather than a fact.

Every row carries the `event_identity` it came from, and
`notifications_source_idx` is unique over `(user_id, kind, source_event_identity)`. So the
sweep is **idempotent by identity** rather than by remembering how far it got: a missed run, a
partial run and an operator catching up all produce the same rows, and two runs racing produce
one notification. A watermark would have the opposite property — a stale one skips
notifications silently, which is the failure nobody notices.

Only events addressed to a person produce one: a `contribution` the member made, a `payout`
they received, and their group `completed`. `fee` is the protocol paying itself, and
`join`/`start` for other people are not news to anyone. Link a wallet *after* a payout and no
notification is back-filled for it — deliberately, because back-filling would make a
notification a historical record rather than a message about something that just happened, and
the activity feed already answers the historical question.

**The order rows arrive in is carried by `created_at`,** which is why the insert sets it
explicitly rather than letting it default. A sweep is one statement, and `now()` is
transaction-start time, so every row in a sweep would otherwise share one timestamp — and the
list query breaks a tie on `id`, which is a random UUID. For the ordinary case of a sweep
catching up on a backlog, the order was a coin flip: a member could be shown round 2's payout
above round 1's contribution. `derive_notifications` now carries each event's chain position
(`ledger`, `tx_index`, `event_index` — the only total order decoded events have) through to the
insert and offsets `created_at` by one microsecond per row in that order, continuing across
batches within a call. The read model, its index and its paging are unchanged, and paging is by
`limit`/`offset` rather than a timestamp cursor, so there is no precision to lose at the wire.
The column still means "when this was derived", not "when this happened": a backlog swept in one
pass carries the time of the sweep.

## Profile images, and who can touch them

A user's photo lives in the private `profile-images` bucket, created and configured by
migration (`drizzle/0004_profile_images.sql`) rather than by a dashboard click, so that
`public = false`, the 2 MiB limit and the three accepted image types are reviewable and
re-applied on every deploy.

**The API never handles image bytes.** The browser uploads and deletes with the publishable
key, under policies that match `(storage.foldername(name))[2]` — the `<uuid>` in
`users/<uuid>/avatar/<name>` — against `auth.uid()`. It then tells `PATCH /api/v1/me` which
object key it used, and what this service stores is a relative path, never a URL. Ownership
comes from the session, never from a value in the request.

**`avatar_path` is constrained, not merely validated.** The column is writable by the
browser through column-level grants, while the runtime check lives here — so a `CHECK`
constraint binds it to `users/<the row's own user_id>/avatar/<32 lowercase hex>.<png|jpg|jpeg|webp>`.
That refusal is what stops a stored path pointing at another user's object, at a
user-chosen name, or at a traversal. The runtime check gives the error message; the
constraint is the part that cannot be bypassed by a second writer.

**There is no cross-user read policy.** A user can read, replace and delete their own
object and no one else's. Showing one member's photo to another would need a policy that
joins to group membership — a decision about what group data means rather than about who
owns an object — so it is not made here, and the app must not render other members'
avatars until it is.

**Deleting an account takes the photo with it.** The auth cascade reaches this service's
tables but cannot reach a Storage blob, so `DELETE /api/v1/me` empties `users/<id>/avatar/`
first and then deletes the account. A cleanup that fails is logged and does not block the
deletion: the account is what the user asked to destroy, and an object whose only reader
has just been deleted is untidy rather than exposed. What deletion does **not** reach is
chain history — contributions and payouts are keyed by wallet and contract address, never
by user id.

## Why `POST /api/v1/transactions/prepare` exists and cannot move money

The document's transaction UX is validate → build → simulate → show details → sign, and it
places transaction preparation in this service's surface. The endpoint takes an unsigned
envelope the **client** built (`{ "transactionXdr": "AAAA…" }`), asks Soroban RPC to
simulate it, and returns the same call with the resource footprint and fee filled in.

It is deliberately an envelope API, not an intent API. An intent-shaped body — "contribute
to group X" — would put this service in the position of deciding an operation's contract,
method and arguments, which is exactly the financial authority the API is not allowed to
have. Given an envelope, the most a compromised API can do is make a call valid or refuse
it; it never holds a key, never signs, and never submits. That is why the response is
checked to still be the caller's own contract, method and source account before it is
returned (`src/lib/prepare.ts`), and why a fee-bump envelope is refused rather than
unwrapped.

Three further limits are worth stating plainly:

- **It is allow-listed.** Only the Factory and groups the index (or a live registration)
  knows about can be simulated here. Without that, the endpoint is an open simulation
  proxy paid for by this service.
- **It is authenticated.** A session is required before any RPC work happens.
- **It is not required.** The web app builds, simulates, assembles and submits locally
  (`susu-web/src/lib/stellar/`), because a write must not depend on this service being up.
  Nothing in the product is blocked when prepare is unavailable; it exists so that a
  client without a Soroban SDK — or one that cannot reach RPC directly — has a path.

A contract's refusal is reported as `200` with `status: "refused"` and the raw host error,
not as an HTTP failure: the request was well-formed and the contract said no, and the
client already owns the error table that explains why. An expired footprint is
`status: "restore_required"`, which is a different remedy and must not be shown to a user
as a failed action.

Fee sponsorship is still **not** implemented, and is a product decision rather than an
implementation detail: it would put a spending key in this service.

The per-session rate limit on this route is deliberately separate from the global one: it is the
only endpoint that spends this service's RPC budget on a caller's behalf, so it carries its own
budget keyed by session rather than sharing a limit with cheap reads.

## Why `POST /api/v1/groups` exists and does not create a group

A group's address is the hash of its own deployment, so the only way to learn that a
group exists is to watch the Factory emit it. The indexer does that on a schedule, which
means there is a window after a creator's confirmation in which the address is real, is
on the public ledger, and is unknown to this API. Creating an invite requires the API to
recognise the group, so without this endpoint a creator could create a group and then be
unable to invite anyone to it until the indexer's next run — the middle of the product's
core journey, blocked by a scheduler.

The body is `{ "contractId": "C…" }` and nothing else. The response is the address and
when the claim lapses. What is stored is an address, the account that claimed it, and an
expiry: no amount, no membership, no status. It cannot make a contract exist, nothing
financial reads it, and it is believed only until it expires — after which the index is
the only thing that can vouch for the address. An account may hold a handful of live
claims at once, so the window cannot be held open across many addresses.

The claim is **not** verified against the chain. Verifying it would mean this service
decoding Soroban event XDR, and the exposure it would close is a code naming an address
that turns out not to be a group — which grants nothing, because the contract decides
who may join. Rate limiting invitation abuse is the proper mitigation and is enforced
per-account on invite creation.

## The read model

These endpoints report what the contracts did. They read the tables `susu-indexer`
writes — `groups`, `group_members`, `contributions`, `payouts`, `protocol_fees`,
`decoded_events` — and never write them. Nothing here decides an amount, a recipient,
or eligibility.

**Amounts are base-unit strings, never numbers.** A group's `contributionAmount` is
`"100000000"`, not `100000000`. A JSON number is an IEEE-754 double and holds integers
exactly only up to 2^53, while an `i128` runs to 39 digits, so an amount that travels
as a number can be silently rounded — and a rounded balance is indistinguishable from a
correct one. Every monetary column is selected with an explicit `::text` cast and
validated on the way out (`src/lib/base-units.ts`), so a lost cast fails loudly instead
of rounding quietly. Clients format base units for display; they do not do arithmetic
on them except in integers.

**The chain-derived tables are not declared in `src/db/schema.ts`.** `susu-indexer` owns
their DDL, and declaring them here would give `drizzle-kit generate` the impression that
this repository owns them and make it emit migrations for another service's tables. See
the comment in that file: the ownership boundary is drawn where the generator enforces it.

**Responses can be stale.** The index trails the chain by up to one scheduled indexing
run, so these endpoints answer "what the index knows", not "what is true now". Responses
carry a five-second `cache-control` for the same reason. A client that needs certainty
reads the contract.

## Security controls

- **Strict CORS allowlist.** An empty allowlist means no cross-origin access.
- **Secure headers** via helmet, **rate limiting** globally, small body limit.
- **Zod validation** at the boundary.
- **Secret-free structured logging** with explicit redaction paths.
- **Elevated-credential guards** that refuse to start when configuration is unsafe:
  - A non-`service_role` token in `SUPABASE_SERVICE_ROLE_KEY`.
  - `PROTOCOL_FEE_BPS` differing from the on-chain `50` bps.
  - `STELLAR_NETWORK=mainnet` without explicit `ALLOW_MAINNET=true`.

## Dependencies

CI runs `pnpm audit --audit-level high` before lint and test, so a known-vulnerable dependency
fails the build in seconds rather than after a full run. **High and critical are the threshold**,
not the default of low: the advisories this tree has carried were both in `esbuild`, reached
only through build-time tooling (`drizzle-kit`, `tsup`) that is never shipped and never serves
traffic. Those were fixed rather than tolerated — a lockfile override in `package.json` holds
`esbuild` at a patched version — but the threshold stays where a real exploit path begins,
because a gate that fails on unactionable findings is one people learn to re-run without
reading.

The gate can go red without anyone changing this repository, since the advisory database is
amended continuously. That is intended: the next push is held until somebody looks.

Reporting is only half a loop, so Dependabot raises the updating pull requests — patch and
minor bumps grouped into one review, majors left to stand on their own. It does not cover the
case of a dependency acquiring an advisory without a version change; that is what the audit
step is for.

## Database security

The database is a rebuildable index of chain activity, never the source of truth.

Row Level Security and least-privilege grants are mandatory for every table exposed through
the Supabase Data API. Guards run in CI and **must** be run for any migration change:

```bash
DATABASE_URL=postgresql://... pnpm db:security-test
```

The guards fail if any table in the exposed schema has RLS disabled, or if any policy is
unconditionally permissive (`USING (true)` / `WITH CHECK (true)`). CI additionally verifies
the guard itself by creating an unprotected table and asserting detection.

The chain-derived tables are covered by the same guards even though this service does not
create them: they have RLS enabled with no policies, and `anon` and `authenticated` hold no
privileges on them.

## Connecting to a hosted database

`pg` does not enable TLS by default, and hosted Postgres — Supabase included — refuses an
unencrypted connection. Left alone, every query fails with `Connection terminated due to
connection timeout`, which reads as a network fault rather than a missing TLS handshake.
The connection therefore configures TLS explicitly (`src/db/ssl.ts`) instead of leaving it to
the connection string.

Supabase serves its pooler from a **private certificate authority**, not a public one:

```text
CN=*.pooler.supabase.com
CN=Supabase Intermediate 2021 CA
CN=Supabase Root 2021 CA        <- self-signed
```

Node's trust store will never carry that root, so the connection can be encrypted without the
server being authenticated. Three consequences:

- **The API refuses to start** against a remote database with neither a CA nor an explicit
  acknowledgement. Encrypted-and-unverified is indistinguishable from encrypted-and-verified at
  runtime, so a deployment that quietly fell back to the weaker one would go unnoticed.
- **Take `DATABASE_SSL_CA` from the dashboard**, at Project Settings → Database → SSL
  configuration. Do not scrape it from the connection: a CA captured over the channel it is
  meant to secure is trust-on-first-use, and an attacker present at capture time would supply
  their own root to be pinned permanently.
- **`DATABASE_SSL_ALLOW_UNVERIFIED=true` accepts the gap deliberately.** Until a CA is supplied,
  anything between this service and the database could terminate the TLS session undetected.

Do **not** append `sslmode=` to `DATABASE_URL`. Modern `pg` reads `sslmode=require` as
`verify-full`, which fails against the pooler's chain; the parameter is ignored on purpose so
there is one source of truth for TLS.

The Supabase direct host (`db.<ref>.supabase.co`) publishes only an IPv6 address, so a network
without IPv6 must use the pooler:
`postgresql://postgres.<ref>:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres`.
Local development against the Supabase CLI stack needs no TLS and is detected automatically.

### Applying a migration to a hosted project

`pnpm db:migrate` decides what to apply from `drizzle.__drizzle_migrations`, which records one
row per migration it has run. A migration applied by hand — through the SQL editor, or by a
targeted script while debugging — is **not** recorded, so the next `pnpm db:migrate` believes it
is missing and replays it. The replay fails on the first `create table` that already exists, and
the error names a statement from a migration that is in fact applied, which sends the reader
looking in the wrong place.

So when applying one by hand, record it in the same transaction. The hash is the SHA-256 of the
file and `created_at` is the `when` value from `drizzle/meta/_journal.json`:

```sql
insert into drizzle.__drizzle_migrations (hash, created_at) values ('<sha256 of the .sql>', <when>);
```

`pnpm db:check` verifies the journal and the files agree; it cannot see the database, so the row
above is the part only a person can get right.

## Development

Requires Node ≥ 22 and pnpm.

```bash
pnpm install
cp .env.example .env    # then fill in values
pnpm dev
```

## Checks

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm db:security-test   # requires DATABASE_URL and psql
```

## Configuration

All configuration is **server-only**. Never add a value from `.env` to any `VITE_`-prefixed
variable — those are bundled into the browser.

## Deployment

[`docs/DEPLOY_RENDER.md`](docs/DEPLOY_RENDER.md) is a walkthrough for hosting this service on
Render: the Supabase SSL configuration it refuses to start without, the port a hosting dashboard will
not guess for you, and why this service has to be deployed before `susu-web` rather than after it.

The blueprint is [`render.yaml`](render.yaml), which supplies everything that is not a secret and
prompts once for everything that is.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Changes to financial semantics, authorization, the read model's money handling, or the
database security guards require human review before merge.

## Security

Reviewed by the maintainer, not by an independent auditor. See [`SECURITY.md`](SECURITY.md) for reporting.

## License

[MIT](LICENSE)
