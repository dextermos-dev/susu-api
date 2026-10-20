/**
 * Group registrations: remembering a group address the chain just produced.
 *
 * WHY THIS EXISTS
 * A group's address is the hash of its own deployment, so the only way to learn a
 * group exists is to watch the Factory emit it. The indexer does that on a
 * schedule, so there is a window after a creator's confirmation in which the
 * address is real and this API has never heard of it. During that window the
 * creator cannot invite anyone, because creating an invite requires the API to
 * recognise the group.
 *
 * A registration bridges that window. It is an address, the account that claimed
 * it, and an expiry — nothing else. It is not a group: it carries no amount, no
 * membership and no status, nothing financial reads it, and it cannot make a
 * contract exist. The index remains the authority on what a group is, and an
 * indexed row makes the claim redundant simply by arriving.
 *
 * THE EXPIRY IS THE SECURITY PROPERTY
 * Nothing has to run for a false claim to stop being believed; the clock does it.
 * That is what makes a claim acceptable without verifying it against the chain:
 * the exposure is bounded in time, and the table cannot accumulate unverified
 * addresses that outlive the indexing lag they were meant to cover.
 *
 * A CAP, SO THE WINDOW CANNOT BE HELD OPEN AT SCALE
 * One account may hold a few live registrations at once. Without the cap an
 * account could register addresses indefinitely and keep a standing list of
 * unverified addresses the API would treat as groups. The cap is deliberately
 * small: a creator needs one, or one per group they are creating, and the honest
 * use of this table is rare.
 */
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { groupRegistrations } from './schema';

type Database = NodePgDatabase<typeof schema>;

/**
 * How long a registration is believed.
 *
 * The indexer runs every five minutes, so this is several runs' worth. The
 * margin is deliberate: the failure it covers is a delayed or missed indexing
 * run, and a window that expired at exactly one run would fail on the first run
 * that was late, which is when the creator most needs it.
 */
export const REGISTRATION_TTL_MS = 30 * 60 * 1000;

/**
 * How many live registrations one account may hold.
 *
 * Small, because the honest use is "the group I just created" and the dishonest
 * use is a standing list. A creator working on several groups at once is
 * plausible; a hundred is not.
 */
export const MAX_LIVE_REGISTRATIONS = 5;

export type RegistrationOutcome =
  | { readonly outcome: 'registered'; readonly contractId: string; readonly expiresAt: string }
  /** The account already holds the maximum number of live registrations. */
  | { readonly outcome: 'too_many' };

export type RegistrationStore = {
  /**
   * Claims that `contractId` is a group, for a bounded while.
   *
   * Idempotent for the account that made the claim, and extended by a repeat so a
   * creator who registers again is not told their own registration expired. It
   * does not extend someone else's claim: a second account registering an address
   * already claimed is told it is registered and changes nothing.
   */
  register(input: { contractId: string; userId: string }): Promise<RegistrationOutcome>;

  /**
   * Whether the address is currently claimed by an unexpired registration.
   *
   * Says nothing about whether it is a group. Callers combine this with the
   * index, and the index is what makes the answer durable.
   */
  isRegistered(contractId: string): Promise<boolean>;
};

export function createRegistrationStore(db: Database): RegistrationStore {
  return {
    async register({ contractId, userId }) {
      return db.transaction(async (tx) => {
        // The lock is the whole reason this is a transaction. The cap is a
        // predicate over the account's live rows, so the check and the insert
        // below must observe the same set — but `SELECT ... FOR UPDATE` only
        // locks rows that already exist. Under READ COMMITTED it cannot stop a
        // concurrent transaction from inserting a new row the first one never
        // saw (a phantom read): two concurrent calls can both read
        // countLive = MAX - 1, both pass the cap check, and both insert.
        //
        // The advisory lock is the actual serialization point. It is keyed by
        // the account, so concurrent registrations for one account queue behind
        // each other while different accounts never block. It is
        // transaction-scoped: held until commit or rollback, then released
        // automatically.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);

        const live = await tx
          .select({ contractId: groupRegistrations.contractId })
          .from(groupRegistrations)
          .where(
            and(
              eq(groupRegistrations.registeredBy, userId),
              gt(groupRegistrations.expiresAt, sql`now()`),
            ),
          )
          .for('update');

        // Expired rows for this account are removed first. They answer nothing —
        // `isRegistered` would ignore them — so leaving them would only accumulate
        // rows and, worse, count against the cap that is meant to measure live
        // claims. Cleaning up the account's own rows keeps that bounded without a
        // background job.
        await tx
          .delete(groupRegistrations)
          .where(
            and(
              eq(groupRegistrations.registeredBy, userId),
              lte(groupRegistrations.expiresAt, sql`now()`),
            ),
          );

        // Computed strictly from the database clock so clock skew between host
        // and database can never violate `expires_at > created_at` or warp the window.
        const sqlExpiresAt = sql`now() + (${REGISTRATION_TTL_MS} * interval '1 millisecond')`;

        // The cap is checked against the claim being *replaced*, so re-registering
        // an address an account already holds is never refused for being at the
        // limit — otherwise the one case that should always work would fail.
        const existing = await tx
          .select({ registeredBy: groupRegistrations.registeredBy })
          .from(groupRegistrations)
          .where(eq(groupRegistrations.contractId, contractId));

        const alreadyMine = existing[0]?.registeredBy === userId;
        if (!alreadyMine && live.length >= MAX_LIVE_REGISTRATIONS) {
          return { outcome: 'too_many' } as const;
        }

        if (alreadyMine) {
          const [updated] = await tx
            .update(groupRegistrations)
            .set({ expiresAt: sqlExpiresAt })
            .where(
              and(
                eq(groupRegistrations.contractId, contractId),
                // Belt and braces against a concurrent claim by another account
                // between the read above and this write: the update matches nothing
                // rather than transferring the row.
                eq(groupRegistrations.registeredBy, userId),
              ),
            )
            .returning({ expiresAt: groupRegistrations.expiresAt });

          if (updated !== undefined) {
            return {
              outcome: 'registered',
              contractId,
              expiresAt: updated.expiresAt.toISOString(),
            } as const;
          }
        }

        // Another account's claim, or none. `onConflictDoNothing` makes the insert
        // safe either way: if the address is already claimed, nothing changes — the
        // existing holder keeps it and this account learns it is registered.
        const [inserted] = await tx
          .insert(groupRegistrations)
          .values({ contractId, registeredBy: userId, expiresAt: sqlExpiresAt })
          .onConflictDoNothing({ target: groupRegistrations.contractId })
          .returning({ expiresAt: groupRegistrations.expiresAt });

        if (inserted !== undefined) {
          return {
            outcome: 'registered',
            contractId,
            expiresAt: inserted.expiresAt.toISOString(),
          } as const;
        }

        const [holder] = await tx
          .select({ expiresAt: groupRegistrations.expiresAt })
          .from(groupRegistrations)
          .where(eq(groupRegistrations.contractId, contractId));

        if (holder !== undefined) {
          return {
            outcome: 'registered',
            contractId,
            expiresAt: holder.expiresAt.toISOString(),
          } as const;
        }

        throw new Error('registration could neither be inserted nor found');
      });
    },

    async isRegistered(contractId) {
      const rows = await db
        .select({ contractId: groupRegistrations.contractId })
        .from(groupRegistrations)
        .where(
          and(
            eq(groupRegistrations.contractId, contractId),
            gt(groupRegistrations.expiresAt, sql`now()`),
          ),
        )
        .limit(1);

      return rows.length > 0;
    },
  };
}
