/**
 * Database schema owned by this service.
 *
 * Phase 4 adds the application tables. The document's phase list places
 * "Supabase Auth + Postgres + RLS + profiles" together because the three are one
 * decision: a table without RLS is a table the browser can read, so the profile
 * table and its policies ship in the same migration.
 *
 * Phase 4 declared `profiles` alone, on the grounds that declaring tables
 * nothing writes to ships dead schema. Phase 5 is the phase that writes to them:
 * `wallet_links`, `invite_links` and `notifications` arrive together with the
 * endpoints and the signing flow that use them, so they are declared here now.
 *
 * Each of the three is deliberately narrower than the browser UI might like. The
 * question that decided every grant below is "who is able to prove they are
 * entitled to do this?", and for two of the three the answer is "only the
 * server": a wallet binding is worthless if a client can declare it, and an
 * invite code is worthless if a client can enumerate it.
 *
 * WHY THE CHAIN-DERIVED TABLES ARE NOT DECLARED HERE
 * `groups`, `group_members`, `contributions`, `payouts`, `protocol_fees` and
 * `decoded_events` belong to the indexer: `susu-indexer` owns their DDL, in
 * `supabase/migrations/20260816000000_chain_derived.sql`. This service only
 * reads them.
 *
 * Declaring them here as well would give `drizzle-kit generate` the impression
 * that this repository owns them, and it would emit `create table` and
 * `alter table` statements for tables another service migrates. Two
 * repositories generating migrations for one table is how a schema drifts, so
 * the ownership boundary is drawn in the one place that enforces it: the
 * generator's schema file.
 *
 * They are read through explicit SQL in `src/db/groups.ts`, which selects each
 * amount with a `::text` cast. That is not belt-and-braces: the indexer's
 * migration documents that a `numeric` read can reach JavaScript as a JSON
 * number, and `src/lib/base-units.ts` explains why that must be a loud failure
 * rather than a round number.
 *
 * MANDATORY REQUIREMENTS FOR EVERY TABLE ADDED HERE
 *
 * 1. Row Level Security is enabled in the same migration that creates the table.
 *    RLS is never silently disabled by a later migration.
 * 2. Policies are deny-by-default, then grant the minimum required operation.
 *    Policies use `auth.uid()` and ownership/membership checks.
 * 3. Postgres grants are tightened alongside RLS: unnecessary `anon` and
 *    `authenticated` privileges are revoked, and only required operations are granted.
 *    RLS does not replace grants.
 * 4. Chain-derived tables (contributions, payouts, transactions, indexed events)
 *    grant browser clients NO insert/update/delete access. Only trusted
 *    server/indexer paths write to them.
 * 5. Columns used by RLS filters (`user_id`, `group_id`, membership keys) are indexed.
 * 6. Database functions default to SECURITY INVOKER. SECURITY DEFINER requires a
 *    safe `search_path`, fully qualified relations, restricted EXECUTE, and review.
 * 7. pgTAP/Supabase security tests cover anonymous denial, ownership and group
 *    boundaries, denied CRUD, Storage policies, and server-only tables.
 */

import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * A user's public profile.
 *
 * Keyed by `user_id`, which is the Supabase Auth user id — the same value
 * `auth.uid()` returns inside a policy. That is what makes the ownership check a
 * direct comparison rather than a lookup through a second table.
 *
 * `display_name` and `avatar_path` are both nullable, and that is deliberate:
 * the document requires that a profile photo "must not block signup", and the
 * same reasoning applies to a display name. A row can therefore exist with
 * nothing in it but the key, and a user who never sets a name is still a valid
 * user. Defaulting either to a placeholder string would make "unset" and
 * "deliberately set to this value" indistinguishable.
 *
 * `avatar_path` stores an object key, never a URL. The document is explicit on
 * this: a stored URL outlives the bucket layout, leaks the storage host into the
 * database, and cannot be re-signed when access policy changes.
 *
 * PRIMARY KEY, NOT A UNIQUE CONSTRAINT
 * The document says `user_id unique`. A primary key is that uniqueness plus a
 * NOT NULL that a bare unique constraint would not add, and it gives the
 * ownership lookup an index for free. A nullable `user_id` would mean a profile
 * nobody can reach — visible to no one and owned by no one.
 *
 * NO FOREIGN KEY IS DECLARED HERE
 * In Supabase this should cascade from `auth.users`, so that deleting a user
 * removes their profile. Drizzle cannot express "add this constraint only if the
 * auth schema exists", and that condition is not hypothetical: CI runs plain
 * Postgres, where `auth.users` does not exist, so an unconditional foreign key
 * would fail to apply there. The constraint is added conditionally in
 * `drizzle/0000_profiles.sql` instead, where the guard can be written out. See
 * that file for the reasoning.
 *
 * `avatar_path` is intentionally not backed by Storage policies yet. The bucket
 * and its owner-scoped policies land with the upload UI in the settings phase;
 * adding the column now keeps the profile a single row rather than a migration
 * later, and the column is unreachable until a policy exists to write it.
 */
export const profiles = pgTable('profiles', {
  userId: uuid('user_id').primaryKey(),

  displayName: text('display_name'),
  avatarPath: text('avatar_path'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;

/**
 * A Stellar wallet bound to an account.
 *
 * PRIMARY KEY ON `user_id`, UNIQUE ON `address`
 * One wallet per account for the MVP, and one account per wallet. The primary
 * key makes the first true by construction: changing wallets replaces the row
 * rather than adding a second one, so there is never a moment where the app
 * cannot say which wallet identifies this user. The unique address makes the
 * second true, and it is the constraint that actually matters — without it two
 * accounts could both claim the same wallet, and the app would have no way to
 * decide which of them the chain considers the group member. That is a
 * correctness problem, not a tidiness problem.
 *
 * WHY THE BROWSER MAY ONLY READ THIS TABLE
 * Binding a wallet is a claim to control a keypair, so it is only worth
 * anything if control is demonstrated. The flow is: authenticated session →
 * server-issued nonce → wallet signature → server verification → row written.
 * A client that could insert here directly would skip the middle three steps,
 * and the signature check would be decorative. The API writes this table with
 * the service role after verifying; `authenticated` is granted `select` on its
 * own row and nothing else.
 *
 * The address format is constrained in SQL rather than only in Zod, because this
 * column is what the rest of the system treats as an identity: a malformed value
 * that reached it would be a row that can never match an on-chain member.
 */
export const walletLinks = pgTable('wallet_links', {
  userId: uuid('user_id').primaryKey(),

  address: text('address').notNull().unique(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An invite to a group, addressed by an opaque code.
 *
 * WHY THE CODE IS NOT THE CONTRACT ADDRESS
 * The frontend's first invite implementation used the group's contract address
 * as the invite code, on the reasoning that it "grants nothing". That reasoning
 * is sound about authority — the contract still decides who may join — but it
 * misses that a contract address is *enumerable*. Anyone can walk the address
 * space, or read it off the chain, and obtain the same page every invited member
 * gets. The document therefore requires "opaque, random, expiring codes
 * protected against enumeration", and this table is where that requirement
 * lives: `code` is 32 random bytes in base64url, unrelated to any address.
 *
 * The check constraints in the migration pin the shape rather than trusting the
 * generator: at least 22 characters of `[A-Za-z0-9_-]`, which is 132 bits of
 * entropy at the floor, so a future code path cannot quietly start issuing
 * short or structured codes. A second constraint rejects codes shaped like a
 * Stellar address, because the first one permits them and that is exactly the
 * mistake this project made the first time: a contract address is long,
 * high-entropy, and publicly enumerable, which is the opposite of a secret.
 *
 * WHY THE BROWSER HAS NO ACCESS AT ALL
 * Not even select. The whole value of the code is that it cannot be guessed, so
 * a client that can list invite rows has defeated it without guessing anything.
 * Creation is authorized and rate-limited by the API, and joins are resolved
 * server-side: the API looks up the code, decides whether the join is allowed,
 * and returns only the group that code points at. `authenticated` and `anon` are
 * granted nothing here; the service role does all of it.
 *
 * NO FOREIGN KEY TO `groups`
 * The group row belongs to the indexer, and an invite may legitimately be
 * created during the window before the indexer has seen the group's creation
 * event. A foreign key would turn ordinary index lag into a failed invite.
 */
export const inviteLinks = pgTable(
  'invite_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** The secret. Opaque, random, unique. Never derived from an address. */
    code: text('code').notNull().unique(),

    /** The group this code admits to, as a Soroban contract address. */
    groupContractId: text('group_contract_id').notNull(),

    /** The user who created it. Cascades: an invite dies with its author. */
    createdBy: uuid('created_by').notNull(),

    /** Absent means the code does not expire. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    /** Absent means unlimited uses, subject to the contract's own capacity. */
    maxUses: integer('max_uses'),

    /** Incremented on each successful join, under a row lock. */
    uses: integer('uses').notNull().default(0),

    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('invite_links_group_idx').on(table.groupContractId),
    index('invite_links_created_by_idx').on(table.createdBy),
  ],
);

/**
 * A message addressed to one user.
 *
 * USER-OWNED, BUT NOT USER-WRITTEN
 * A notification is only meaningful if the system issued it, so the browser is
 * granted `select` on its own rows and `update` on the single column that means
 * "I have seen this". It is granted no insert: a client that could write here
 * could produce a notification claiming a payout had been confirmed, which is
 * precisely the kind of message a user is meant to be able to trust. Rows are
 * written by trusted paths — the API and the indexer — using the service role.
 *
 * `data` carries the context a notification needs to be actionable (the group
 * contract address, a round number, a transaction hash) without the database
 * having to grow a column per event type.
 *
 * `kind` is text with a format check rather than an enum. The set of kinds grows
 * with the product — the document lists invites, due and confirmed
 * contributions, payout ready and confirmed, completion and security events —
 * and a Postgres enum would make each addition a migration on a table the
 * indexer also writes to. The format check still stops a typo becoming a new
 * kind nobody reads.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    userId: uuid('user_id').notNull(),

    /** A stable machine-readable event name, e.g. `payout_confirmed`. */
    kind: text('kind').notNull(),

    title: text('title').notNull(),
    body: text('body'),

    /** Event context. Never authoritative for money — the chain is. */
    data: jsonb('data').notNull().default({}),

    /** Null until the user has seen it. */
    readAt: timestamp('read_at', { withTimezone: true }),

    /**
     * The decoded event this was derived from, and the reason re-deriving is
     * safe.
     *
     * A notification is not authored, it is derived, so the sweep that produces
     * them is repeatable and *will* be repeated — after a gap in the schedule,
     * or by an operator catching up. The unique index over
     * `(user_id, kind, source_event_identity)` is what makes the second run a
     * no-op rather than a duplicate: idempotency by identity, enforced by an
     * index rather than by reading first and deciding second.
     *
     * Null for anything not derived from a chain event — an operator's message,
     * or a future path that has no event behind it. Postgres treats nulls as
     * distinct in a unique index, so those rows coexist freely.
     */
    sourceEventIdentity: text('source_event_identity'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The list endpoint is always "my notifications, newest first", so the index
    // is on the pair rather than on either column alone. The unique index in the
    // migration leads with `user_id` too, so it serves the same query.
    index('notifications_user_created_idx').on(table.userId, table.createdAt),
    uniqueIndex('notifications_source_idx').on(table.userId, table.kind, table.sourceEventIdentity),
  ],
);

export type WalletLink = typeof walletLinks.$inferSelect;
export type NewWalletLink = typeof walletLinks.$inferInsert;
export type InviteLink = typeof inviteLinks.$inferSelect;
export type NewInviteLink = typeof inviteLinks.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

/**
 * A wallet-link nonce that has been spent.
 *
 * WHY THIS TABLE EXISTS AT ALL
 * The nonce itself is not stored. It is an HMAC-signed token the server can
 * validate without a lookup: rotating `WALLET_NONCE_SECRET` invalidates every
 * outstanding nonce at once, and issuing one costs no write. What a signed token
 * cannot do by itself is be *single-use* — the same token verifies as many times
 * as it is presented until it expires. This table is the part that cannot be
 * derived, so it is the part that is stored.
 *
 * The primary key is the nonce id, so a replay is not a check that can pass — it
 * is an insert that cannot succeed. Uniqueness is enforced by the index rather
 * than by reading first and deciding second, which is the difference between a
 * guarantee and a race.
 *
 * `expires_at` is stored rather than recomputed so the row can be reaped without
 * the secret: a cleanup that needed to verify a signature to know it could delete
 * a row would be unable to clean up after a key rotation.
 *
 * Server-only. No browser role is granted anything here, and RLS is enabled with
 * no policies: knowing which nonces exist is of no use to a client, and the
 * values are written and read exclusively by the API.
 */
export const walletLinkNonces = pgTable(
  'wallet_link_nonces',
  {
    /** The nonce's unique id, from the signed token. */
    jti: text('jti').primaryKey(),

    /** The account the nonce was issued to. A nonce is not transferable. */
    userId: uuid('user_id').notNull(),

    /** When the token stops being valid, copied from the token's own claim. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    consumedAt: timestamp('consumed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The reaper's query is "delete everything past its expiry", so the index is
    // on the expiry alone rather than on the pair.
    index('wallet_link_nonces_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * A record that a user redeemed an invite.
 *
 * WHY A JOIN TABLE AND NOT JUST A COUNTER
 * `invite_links.uses` is a counter, and a counter cannot express "this user has
 * already redeemed this code". Without that fact, a member who opens their invite
 * link twice consumes two of a limited code's uses, and the code runs out on a
 * group that is not full. The document asks for a join that is *idempotent*, and
 * idempotence requires remembering who has joined — which is what this table is.
 *
 * The primary key is the pair, so the second redemption is a conflict rather than
 * a duplicate row, and the increment can be made conditional on this insert
 * having happened. The two facts — "who joined" and "how many uses" — are then
 * written in one transaction under a lock on the invite, and cannot disagree.
 *
 * Server-only, like the table it records: a client that could insert here could
 * burn a limited invite's uses without joining.
 */
export const inviteRedemptions = pgTable(
  'invite_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** The invite that was redeemed. */
    inviteId: uuid('invite_id').notNull(),

    /** The account that redeemed it. */
    userId: uuid('user_id').notNull(),

    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The uniqueness that makes redemption idempotent. Named so a conflict in
    // application code can be told apart from any other unique violation.
    uniqueIndex('invite_redemptions_invite_user_key').on(table.inviteId, table.userId),
    index('invite_redemptions_user_idx').on(table.userId),
  ],
);

export type WalletLinkNonce = typeof walletLinkNonces.$inferSelect;
export type NewWalletLinkNonce = typeof walletLinkNonces.$inferInsert;
export type InviteRedemption = typeof inviteRedemptions.$inferSelect;
export type NewInviteRedemption = typeof inviteRedemptions.$inferInsert;

/**
 * A group that has been created on chain but not yet indexed.
 *
 * THE GAP THIS CLOSES
 * A group's address is the hash of its own deployment, so the only way to know a
 * group exists is to have watched the Factory emit it — which is what the indexer
 * does, on a five-minute schedule. Between a creator's confirmation and the
 * indexer's next run there is a window in which the address is real, is on the
 * public ledger, and is unknown to this API.
 *
 * The schema already anticipated that window for invites: `invite_links` has no
 * foreign key to the group, with the reasoning that "an invite may legitimately be
 * created during the window before the indexer has seen the group's creation
 * event". The route then closed the window again by refusing to create an invite
 * for a group it could not find, so a creator could not share an invite until the
 * indexer caught up. This table is what lets the route honour the intent: the
 * creator registers the address the chain just gave them, and the API treats it as
 * a group for a short while.
 *
 * WHAT THIS IS NOT
 * It is not a group. Nothing financial reads it, it carries no amount, no
 * membership, no status, and a row here does not make a contract exist. `groups`
 * remains the indexer's table and the index remains the authority on what a group
 * is; this is a claim with an expiry, and the index overwrites it by simply
 * existing. Because of that, `expires_at` is the load-bearing column: the
 * registration stops being believed on its own, without anything having to run.
 *
 * WHY A CLAIM IS ACCEPTABLE HERE
 * Invite creation is already open to any authenticated account for any group the
 * index knows — a code grants no authority, and the contract decides who may join
 * — so a registration widens the set of addresses a code can name, not the power a
 * code has. The cost of a false claim is bounded by the expiry, and capped per
 * account so a single account cannot hold the window open on many addresses at
 * once. Verifying the claim against the chain instead would mean this service
 * encoding and decoding Soroban XDR, which is a larger and more fragile thing than
 * the gap it would close; the real mitigation for invitation abuse is rate
 * limiting, which is enforced per-account on invite creation.
 */
export const groupRegistrations = pgTable(
  'group_registrations',
  {
    /** The address the chain returned. One claim per address. */
    contractId: text('contract_id').primaryKey(),

    /** The account that made the claim. Cascades: a claim dies with its author. */
    registeredBy: uuid('registered_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /** After this instant the index is the only thing that can vouch for the row. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // Every read is "is this address registered and still within its window", so
    // the expiry is filtered on and indexed rather than only stored.
    index('group_registrations_expires_at_idx').on(table.expiresAt),
    // The per-account cap counts a user's live claims, which is this index.
    index('group_registrations_registered_by_idx').on(table.registeredBy),
  ],
);

export type GroupRegistration = typeof groupRegistrations.$inferSelect;
export type NewGroupRegistration = typeof groupRegistrations.$inferInsert;
