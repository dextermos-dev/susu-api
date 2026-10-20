/**
 * The invite store: creating codes, and redeeming them exactly once.
 *
 * Redemption is the interesting operation. `invite_links.uses` is a counter with
 * a ceiling, and two things have to be true at the same time that a counter
 * alone cannot express:
 *
 *   1. Concurrent joins must not exceed `max_uses`. That needs a lock, not a
 *      read-then-write, or two requests can both read `uses = 4` against a
 *      ceiling of 5 and both write 5.
 *   2. A member redeeming the same code twice must not consume two uses. That
 *      needs the identity of the redeemer, which is what `invite_redemptions`
 *      records; the unique key on the pair makes the second attempt a no-op
 *      rather than a second increment.
 *
 * So the whole redemption is one transaction: the invite row is locked, the
 * existing redemption is looked for, capacity is checked, and the redemption row
 * and the counter are written together. The lock is what makes the capacity check
 * meaningful; the unique index is what makes the redemption idempotent.
 *
 * The chain is still the authority on who may join and how large a group is.
 * This endpoint resolves a code and claims a use so that a limited invite is not
 * issued more times than it allows — nothing more.
 *
 * A USE IS NOT SPENT ON A JOIN THAT CANNOT HAPPEN
 * A code can outlive the window it was made for: groups open, fill, and start,
 * and a link shared before that keeps working afterwards. Redeeming such a code
 * used to consume a use and then discover, from the client's first read of the
 * group, that joining was never possible. `shouldClaim` lets the caller decline
 * the claim in that case, so the invite is left intact. The code still resolves,
 * because the client needs the group's address to explain what happened.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { inviteLinks, inviteRedemptions } from './schema';

type Database = NodePgDatabase<typeof schema>;

export type InviteRecord = {
  readonly id: string;
  readonly code: string;
  readonly groupContractId: string;
  readonly createdBy: string;
  readonly expiresAt: string | null;
  readonly maxUses: number | null;
  readonly uses: number;
  readonly createdAt: string;
};

export type RedeemOutcome =
  /**
   * The use was claimed, or had already been claimed by this same user.
   *
   * `groupContractId` is returned because the code is what identifies the group:
   * an invite link carries a code and no address, so the caller learns which
   * contract to join from this.
   *
   * `claimed` is false in one case: the code resolved to a group that is already
   * known not to be open, so there was nothing to spend a use on. The group is
   * still reported, because the caller needs the address to say so — "this group
   * has already started" is a better answer than "that code is no good", and it
   * is only reachable if the code resolves.
   */
  | {
      readonly outcome: 'redeemed';
      readonly inviteId: string;
      readonly groupContractId: string;
      readonly claimed: boolean;
    }
  /** No such code. */
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'revoked' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'exhausted' };

export type InviteStore = {
  create(input: {
    code: string;
    groupContractId: string;
    createdBy: string;
    expiresAt: Date | null;
    maxUses: number | null;
  }): Promise<InviteRecord>;

  /**
   * Claims a use of the invite identified by `code`, for a join by `userId`, and
   * reports which group the code admits to.
   *
   * Idempotent per (invite, user): redeeming twice succeeds both times and
   * consumes one use.
   *
   * `shouldClaim` is asked once, before anything is written, whether this
   * redemption should spend a use. It exists so that a code pointing at a group
   * which can no longer be joined is still resolved — the caller needs the
   * address — without consuming the invite. An answer of `false` is not a
   * refusal: the group is reported as usual and nothing is recorded.
   *
   * It is deliberately a courtesy and not a control. The chain refuses the join
   * on its own, and this answer can be stale by one indexer run, so it may only
   * ever be used to decline to spend a use, never to grant a join.
   */
  redeem(input: {
    code: string;
    userId: string;
    expectedGroup?: string;
    shouldClaim?: (groupContractId: string) => Promise<boolean>;
  }): Promise<RedeemOutcome>;
};

function toRecord(row: schema.InviteLink): InviteRecord {
  return {
    id: row.id,
    code: row.code,
    groupContractId: row.groupContractId,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    maxUses: row.maxUses,
    uses: row.uses,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createInviteStore(db: Database): InviteStore {
  return {
    async create(input) {
      const [row] = await db
        .insert(inviteLinks)
        .values({
          code: input.code,
          groupContractId: input.groupContractId,
          createdBy: input.createdBy,
          expiresAt: input.expiresAt,
          maxUses: input.maxUses,
        })
        .returning();

      if (row === undefined) throw new Error('invite insert returned no row');
      return toRecord(row);
    },

    async redeem({ code, userId, expectedGroup, shouldClaim }) {
      // The claim decision needs I/O (a group-status read on the shared pool),
      // so it is resolved here, before the transaction opens. Awaiting it while
      // holding the invite row lock would hold the lock across a network round
      // trip, serializing every concurrent redemption behind a slow status read
      // and risking pool exhaustion. `groupContractId` is immutable after
      // creation, so this preview cannot disagree with the locked row below.
      //
      // The lookups below are courtesy only: the transaction re-checks
      // everything under the lock and stays the authority. They exist so
      // `shouldClaim` is not asked when the answer is already known — no such
      // code, or a redemption this user already made.
      const [preview] = await db
        .select()
        .from(inviteLinks)
        .where(eq(inviteLinks.code, code))
        .limit(1);

      if (preview === undefined) return { outcome: 'not_found' } as const;
      if (expectedGroup !== undefined && preview.groupContractId !== expectedGroup) {
        return { outcome: 'not_found' } as const;
      }
      if (preview.revokedAt !== null) return { outcome: 'revoked' } as const;
      if (preview.expiresAt !== null && preview.expiresAt.getTime() <= Date.now()) {
        return { outcome: 'expired' } as const;
      }

      const [already] = await db
        .select({ id: inviteRedemptions.id })
        .from(inviteRedemptions)
        .where(
          and(eq(inviteRedemptions.inviteId, preview.id), eq(inviteRedemptions.userId, userId)),
        )
        .limit(1);

      if (already !== undefined) {
        return {
          outcome: 'redeemed',
          inviteId: preview.id,
          groupContractId: preview.groupContractId,
          claimed: true,
        } as const;
      }

      const claim =
        shouldClaim === undefined ? undefined : await shouldClaim(preview.groupContractId);

      return db.transaction(async (tx) => {
        // `for update` is the whole reason this is a transaction. Without it the
        // capacity check below is advisory: two concurrent joins would both read
        // the same `uses` and both be told there is room.
        const locked = await tx
          .select()
          .from(inviteLinks)
          .where(eq(inviteLinks.code, code))
          .for('update');

        const invite = locked[0];
        if (invite === undefined) return { outcome: 'not_found' } as const;
        if (expectedGroup !== undefined && invite.groupContractId !== expectedGroup) {
          return { outcome: 'not_found' } as const;
        }
        if (invite.revokedAt !== null) return { outcome: 'revoked' } as const;
        if (invite.expiresAt !== null && invite.expiresAt.getTime() <= Date.now()) {
          return { outcome: 'expired' } as const;
        }

        // The code identifies the group, which is the point of it: an invite link
        // carries the code and nothing else, so a lookup that needed the contract
        // address as well could never be satisfied by the link. `code` is unique,
        // so this is a single row.
        const groupContractId = invite.groupContractId;

        // Checked before capacity, so a member who already redeemed is idempotent
        // even when the invite has since filled up. Reporting "exhausted" to
        // someone who is already in would be true about the invite and wrong
        // about their situation.
        const [existing] = await tx
          .select({ id: inviteRedemptions.id })
          .from(inviteRedemptions)
          .where(
            and(eq(inviteRedemptions.inviteId, invite.id), eq(inviteRedemptions.userId, userId)),
          )
          .limit(1);

        if (existing !== undefined) {
          return {
            outcome: 'redeemed',
            inviteId: invite.id,
            groupContractId,
            claimed: true,
          } as const;
        }

        // `claim` was resolved before the transaction opened, so the row lock is
        // never held across the status read's I/O. Asked before capacity and
        // before anything is written, so a group that cannot be joined leaves
        // the invite exactly as it was.
        if (claim === false) {
          return {
            outcome: 'redeemed',
            inviteId: invite.id,
            groupContractId,
            claimed: false,
          } as const;
        }

        if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
          return { outcome: 'exhausted' } as const;
        }

        await tx.insert(inviteRedemptions).values({ inviteId: invite.id, userId });

        // Incremented in SQL rather than from the value read above, so the
        // update cannot write back a stale count if anything else has touched
        // the row. The lock makes that unlikely; this makes it harmless.
        await tx
          .update(inviteLinks)
          .set({ uses: sql`${inviteLinks.uses} + 1` })
          .where(eq(inviteLinks.id, invite.id));

        return {
          outcome: 'redeemed',
          inviteId: invite.id,
          groupContractId,
          claimed: true,
        } as const;
      });
    },
  };
}
