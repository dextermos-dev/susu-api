import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInviteStore } from '../src/db/invites';
import type { InviteStore } from '../src/db/invites';
import { createTestDb, type TestDb } from './support/pglite';
import { GROUP_CONTRACT_ID, OTHER_CONTRACT_ID } from './support/fixtures';

/**
 * The invite store against a real Postgres.
 *
 * The route tests inject a fake store, which cannot show whether a claim was
 * actually written - the thing this file exists to check. `uses` is a counter
 * with a ceiling, and the invariant that matters is not what the store returns
 * but what is left in the tables afterwards, so every assertion here reads the
 * rows back rather than trusting the return value.
 *
 * The specific case is a code that outlived its window: the group filled up and
 * started while the link was still circulating. Redeeming it used to spend a use
 * and only then let the client discover, from the chain, that joining was never
 * possible. The claim is now withheld, and "withheld" has to mean nothing was
 * written at all.
 */

let testDb: TestDb;
let store: InviteStore;

beforeAll(async () => {
  testDb = await createTestDb();
  store = createInviteStore(testDb.db);
});

afterAll(async () => {
  await testDb.close();
});

/**
 * A distinct user per fixture.
 *
 * Valid uuid shape so the columns accept it, and version 4 in the third group so
 * nothing that validates versions rejects it either.
 */
let userCounter = 0;
function nextUser(): string {
  userCounter += 1;
  return `${String(userCounter).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

/**
 * A distinct, correctly shaped code per fixture.
 *
 * The table constrains the shape and forbids anything address-like, so a test
 * that invented a short code would fail on the insert rather than on the
 * behaviour it meant to check.
 */
let codeCounter = 0;
function nextCode(): string {
  codeCounter += 1;
  return `invitecode${String(codeCounter).padStart(6, '0')}${'x'.repeat(24)}`;
}

/** Creates an invite owned by a fresh user, with the given ceiling. */
async function seedInvite(maxUses: number | null): Promise<{ code: string; id: string }> {
  const createdBy = nextUser();
  await testDb.createUser(createdBy);

  const invite = await store.create({
    code: nextCode(),
    groupContractId: GROUP_CONTRACT_ID,
    createdBy,
    expiresAt: null,
    maxUses,
  });

  return { code: invite.code, id: invite.id };
}

/** The invite's own accounting, read from the row rather than from a return value. */
async function usesOf(inviteId: string): Promise<number> {
  const { rows } = await testDb.query('select uses from invite_links where id = $1', [inviteId]);
  return rows[0]?.['uses'] as number;
}

async function redemptionCount(inviteId: string): Promise<number> {
  const { rows } = await testDb.query(
    'select count(*)::int as count from invite_redemptions where invite_id = $1',
    [inviteId],
  );
  return rows[0]?.['count'] as number;
}

describe('a claim that is withheld', () => {
  it('reports the group, and writes nothing', async () => {
    const invite = await seedInvite(1);
    const userId = nextUser();
    await testDb.createUser(userId);

    const outcome = await store.redeem({
      code: invite.code,
      userId,
      shouldClaim: async () => false,
    });

    // The group is still reported: without the address the client cannot say
    // *why* the join is impossible, only that the code failed.
    expect(outcome).toEqual({
      outcome: 'redeemed',
      inviteId: invite.id,
      groupContractId: GROUP_CONTRACT_ID,
      claimed: false,
    });

    // The point of the change. A withheld claim must leave no trace at all: not a
    // spent use, and not a redemption row that would make the visitor look like
    // they had already joined.
    expect(await usesOf(invite.id)).toBe(0);
    expect(await redemptionCount(invite.id)).toBe(0);
  });

  it('does not consume the capacity it declined to spend', async () => {
    // A single-use invite is the case where this is observable: if the withheld
    // attempt had burned the only place, the next visitor would be refused.
    const invite = await seedInvite(1);
    const declined = nextUser();
    const genuine = nextUser();
    await testDb.createUser(declined);
    await testDb.createUser(genuine);

    await store.redeem({ code: invite.code, userId: declined, shouldClaim: async () => false });

    const second = await store.redeem({ code: invite.code, userId: genuine });

    expect(second).toMatchObject({ outcome: 'redeemed', claimed: true });
    expect(await usesOf(invite.id)).toBe(1);

    // And the ceiling still holds, so the withheld claim did not turn a
    // single-use code into a two-use one.
    const third = nextUser();
    await testDb.createUser(third);
    expect(await store.redeem({ code: invite.code, userId: third })).toEqual({
      outcome: 'exhausted',
    });
  });

  it('is not sticky: the same visitor can claim later', async () => {
    const invite = await seedInvite(1);
    const userId = nextUser();
    await testDb.createUser(userId);

    await store.redeem({ code: invite.code, userId, shouldClaim: async () => false });
    // No redemption was recorded, so nothing marks this user as having spent
    // their claim. A second attempt, once the group is joinable, must work.
    const claimed = await store.redeem({ code: invite.code, userId });

    expect(claimed).toMatchObject({ outcome: 'redeemed', claimed: true });
    expect(await usesOf(invite.id)).toBe(1);
    expect(await redemptionCount(invite.id)).toBe(1);
  });
});

describe('when the code targets a different group than expected', () => {
  it('returns not_found and writes nothing to invite_links or invite_redemptions', async () => {
    const invite = await seedInvite(1);
    const userId = nextUser();
    await testDb.createUser(userId);

    const outcome = await store.redeem({
      code: invite.code,
      userId,
      expectedGroup: OTHER_CONTRACT_ID,
    });

    expect(outcome).toEqual({ outcome: 'not_found' });
    expect(await usesOf(invite.id)).toBe(0);
    expect(await redemptionCount(invite.id)).toBe(0);
  });

  it('allows a subsequent join to the correct group and spends exactly one use', async () => {
    const invite = await seedInvite(1);
    const userId = nextUser();
    await testDb.createUser(userId);

    // Mismatched group attempt returns not_found without burning the use
    const firstOutcome = await store.redeem({
      code: invite.code,
      userId,
      expectedGroup: OTHER_CONTRACT_ID,
    });
    expect(firstOutcome).toEqual({ outcome: 'not_found' });
    expect(await usesOf(invite.id)).toBe(0);
    expect(await redemptionCount(invite.id)).toBe(0);

    // Subsequent correct group attempt succeeds and spends exactly one use
    const secondOutcome = await store.redeem({
      code: invite.code,
      userId,
      expectedGroup: GROUP_CONTRACT_ID,
    });
    expect(secondOutcome).toMatchObject({
      outcome: 'redeemed',
      inviteId: invite.id,
      groupContractId: GROUP_CONTRACT_ID,
      claimed: true,
    });
    expect(await usesOf(invite.id)).toBe(1);
    expect(await redemptionCount(invite.id)).toBe(1);
  });

  it('does not invoke shouldClaim on mismatch', async () => {
    const invite = await seedInvite(1);
    const userId = nextUser();
    await testDb.createUser(userId);

    let consulted = false;
    const outcome = await store.redeem({
      code: invite.code,
      userId,
      expectedGroup: OTHER_CONTRACT_ID,
      shouldClaim: async () => {
        consulted = true;
        return true;
      },
    });

    expect(outcome).toEqual({ outcome: 'not_found' });
    expect(consulted).toBe(false);
  });
});

describe('a claim that is taken', () => {
  it('spends one use and records who spent it', async () => {
    const invite = await seedInvite(3);
    const userId = nextUser();
    await testDb.createUser(userId);

    const outcome = await store.redeem({
      code: invite.code,
      userId,
      shouldClaim: async () => true,
    });

    expect(outcome).toEqual({
      outcome: 'redeemed',
      inviteId: invite.id,
      groupContractId: GROUP_CONTRACT_ID,
      claimed: true,
    });
    expect(await usesOf(invite.id)).toBe(1);
    expect(await redemptionCount(invite.id)).toBe(1);
  });

  it('claims when nothing asked, so a caller that omits the check is unchanged', async () => {
    const invite = await seedInvite(3);
    const userId = nextUser();
    await testDb.createUser(userId);

    expect(await store.redeem({ code: invite.code, userId })).toMatchObject({ claimed: true });
    expect(await usesOf(invite.id)).toBe(1);
  });

  it('still reports a member who already redeemed, and does not ask again', async () => {
    const invite = await seedInvite(1);
    const userId = nextUser();
    await testDb.createUser(userId);

    await store.redeem({ code: invite.code, userId });

    // A member re-opening their link after the group started. Their use was spent
    // legitimately and idempotence outranks the status check: telling them their
    // invite is no good would be true about the group and wrong about them. The
    // check must not even be consulted, so a callback that would decline proves it.
    let asked = false;
    const again = await store.redeem({
      code: invite.code,
      userId,
      shouldClaim: async () => {
        asked = true;
        return false;
      },
    });

    expect(again).toEqual({
      outcome: 'redeemed',
      inviteId: invite.id,
      groupContractId: GROUP_CONTRACT_ID,
      claimed: true,
    });
    expect(asked).toBe(false);
    // Still one, not two: reporting the same member twice is not a second use.
    expect(await usesOf(invite.id)).toBe(1);
    expect(await redemptionCount(invite.id)).toBe(1);
  });
});

describe('what the claim check is told', () => {
  it('is handed the group the code admits to, not the code', async () => {
    const invite = await seedInvite(1);
    const userId = nextUser();
    await testDb.createUser(userId);

    let seen: string | undefined;
    await store.redeem({
      code: invite.code,
      userId,
      shouldClaim: async (groupContractId) => {
        seen = groupContractId;
        return true;
      },
    });

    // The callback cannot answer a question about the group without being told
    // which group, and the code is opaque - the store is the only thing that can
    // resolve it.
    expect(seen).toBe(GROUP_CONTRACT_ID);
    expect(seen).not.toBe(OTHER_CONTRACT_ID);
  });
});

describe('the claim check no longer runs under the row lock', () => {
  /**
   * Records each time the store opens a transaction, so a test can prove the
   * claim decision's I/O finished before the transaction — and with it the
   * invite row lock — ever opened.
   */
  function withTransactionSpy(db: TestDb['db'], order: string[]): TestDb['db'] {
    const spy = Object.create(
      Object.getPrototypeOf(db),
      Object.getOwnPropertyDescriptors(db),
    ) as TestDb['db'];
    const original = (db.transaction as unknown as (...args: unknown[]) => unknown).bind(db);
    Object.defineProperty(spy, 'transaction', {
      value: (...args: unknown[]) => {
        order.push('transaction');
        return original(...args);
      },
      writable: true,
      configurable: true,
    });
    return spy;
  }

  it('resolves shouldClaim before the transaction opens', async () => {
    const invite = await seedInvite(3);
    const userId = nextUser();
    await testDb.createUser(userId);

    const order: string[] = [];
    const observedStore = createInviteStore(withTransactionSpy(testDb.db, order));

    const outcome = await observedStore.redeem({
      code: invite.code,
      userId,
      shouldClaim: async () => {
        order.push('shouldClaim');
        return true;
      },
    });

    // The status read is the I/O the issue is about. If it resolved after the
    // transaction opened, the row lock would be held across that network round
    // trip; resolving it first is the whole fix.
    expect(order).toEqual(['shouldClaim', 'transaction']);
    expect(outcome).toMatchObject({ outcome: 'redeemed', claimed: true });
  });

  it('a burst of concurrent redemptions completes without deadlock', async () => {
    const invite = await seedInvite(null);
    const users: string[] = [];
    for (let i = 0; i < 8; i++) {
      const userId = nextUser();
      await testDb.createUser(userId);
      users.push(userId);
    }

    // Simulates the slow group-status read from the issue. Before the fix this
    // I/O ran while holding the row lock, so every redemption queued behind the
    // previous one's status read.
    const slowClaim = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return true;
    };

    const outcomes = await Promise.all(
      users.map((userId) => store.redeem({ code: invite.code, userId, shouldClaim: slowClaim })),
    );

    expect(outcomes.every((o) => o.outcome === 'redeemed' && o.claimed)).toBe(true);
    expect(await usesOf(invite.id)).toBe(users.length);
    expect(await redemptionCount(invite.id)).toBe(users.length);
  });
});
