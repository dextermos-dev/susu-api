import { afterAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { InviteStore, RedeemOutcome } from '../src/db/invites';
import type { GroupStatus } from '../src/db/groups';
import type { TokenVerifier } from '../src/auth/verify';
import { configureTestEnv, GROUP_CONTRACT_ID, OTHER_CONTRACT_ID } from './support/fixtures';

configureTestEnv();

const USER_ID = '11111111-1111-1111-1111-111111111111';
const CODE = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const AUTH = { authorization: 'Bearer a-good-token' };

const built: FastifyInstance[] = [];

afterAll(async () => {
  await Promise.all(built.map(async (app) => app.close()));
});

type FakeStore = InviteStore & {
  create: ReturnType<typeof vi.fn>;
  redeem: ReturnType<typeof vi.fn>;
};

function fakeStore(): FakeStore {
  return {
    create: vi.fn(async (input: Record<string, unknown>) => ({
      id: '99999999-9999-9999-9999-999999999999',
      code: input['code'] as string,
      groupContractId: input['groupContractId'] as string,
      createdBy: input['createdBy'] as string,
      expiresAt: (input['expiresAt'] as Date | null)?.toISOString() ?? null,
      maxUses: (input['maxUses'] as number | null) ?? null,
      uses: 0,
      createdAt: new Date(0).toISOString(),
    })),
    redeem: vi.fn(
      async () =>
        ({
          outcome: 'redeemed',
          inviteId: 'invite-id',
          groupContractId: GROUP_CONTRACT_ID,
        }) as RedeemOutcome,
    ),
  } as unknown as FakeStore;
}

type Harness = {
  app: FastifyInstance;
  store: FakeStore;
  groupExists: ReturnType<typeof vi.fn>;
  groupStatus: ReturnType<typeof vi.fn>;
};

async function harness(
  options: {
    store?: FakeStore;
    known?: boolean;
    registered?: boolean;
    /** What the read model says the group's status is, or `undefined` for "not seen yet". */
    status?: GroupStatus;
  } = {},
): Promise<Harness> {
  const { buildServer } = await import('../src/server');

  const store = options.store ?? fakeStore();
  const groupExists = vi.fn(async () => options.known ?? true);
  const groupStatus = vi.fn(async () => options.status);
  // The index trailing the chain is the case this covers: `known` is the index's
  // answer, `registered` the creator's unexpired registration.
  const isRegistered = vi.fn(async () => options.registered ?? false);
  const verify = vi.fn(async (token: string) => {
    if (token.startsWith('user-')) {
      return { id: token, email: `${token}@example.com` };
    }
    return { id: USER_ID, email: 'ada@example.com' };
  });

  const app = await buildServer({
    probeDatabase: async () => {},
    verifyToken: verify as unknown as TokenVerifier,
    inviteStore: store,
    registrations: { register: vi.fn(), isRegistered } as never,
    readModel: {
      groupExists,
      groupStatus,
      listGroups: vi.fn(),
      getGroup: vi.fn(),
      listContributions: vi.fn(),
      listPayouts: vi.fn(),
      listActivity: vi.fn(),
    } as never,
  });
  built.push(app);

  return { app, store, groupExists, groupStatus };
}

describe('POST /api/v1/groups/:contractId/invites', () => {
  it('refuses an unauthenticated request', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('creates a code for an existing group', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(201);
    const data = response.json().data;
    // 32 bytes in base64url.
    expect(data.code).toHaveLength(43);
    expect(data.groupContractId).toBe(GROUP_CONTRACT_ID);
    expect(data.maxUses).toBeNull();
    expect(typeof data.expiresAt).toBe('string');

    // The creator is the authenticated user, never a value from the body.
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: USER_ID, groupContractId: GROUP_CONTRACT_ID }),
    );
  });

  it('issues a code that is not the group address', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: {},
    });

    // The failure this project already made once: a contract address is public
    // and enumerable, so using it as a code means everyone has the code.
    expect(response.json().data.code).not.toBe(GROUP_CONTRACT_ID);
    expect(response.json().data.code).not.toMatch(/^[GC][A-Z2-7]{55}$/);
  });

  it('defaults the expiry rather than issuing a code that never expires', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: {},
    });

    const expiresAt = Date.parse(response.json().data.expiresAt);
    // The document requires expiring codes; "never" is the one value that cannot
    // be walked back after a leak.
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 8 * 24 * 60 * 60 * 1000);
  });

  it('honours an explicit expiry and use limit', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: { expiresInHours: 2, maxUses: 3 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.maxUses).toBe(3);
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ maxUses: 3 }));
  });

  it('refuses an expiry beyond the maximum', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: { expiresInHours: 24 * 365 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
  });

  it('refuses a non-positive use limit', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: { maxUses: 0 },
    });

    // Zero uses is far likelier to be a bug than an intention, and omitting the
    // field already means unlimited.
    expect(response.statusCode).toBe(400);
  });

  it('reports an unknown group rather than creating a code for it', async () => {
    const { app, store } = await harness({ known: false });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'group_not_found' });
    expect(store.create).not.toHaveBeenCalled();
  });

  /**
   * The index trails the chain by up to one scheduled run, and a creator who has
   * just made a group is the person about to invite someone to it. Before this,
   * the route refused for the length of that lag — the document's journey is
   * "create group, then share invite", and the middle of it did not work.
   */
  it('creates a code for a group the indexer has not seen yet but its creator registered', async () => {
    const { app, store, groupExists } = await harness({ known: false, registered: true });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.groupContractId).toBe(GROUP_CONTRACT_ID);
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ groupContractId: GROUP_CONTRACT_ID }),
    );
    // The index was still asked first: a registration is a fallback for the gap,
    // not a way to skip the authority.
    expect(groupExists).toHaveBeenCalledWith(GROUP_CONTRACT_ID);
  });

  it('refuses a registration that has expired', async () => {
    // `registered: false` is what an expired registration reports: the store
    // filters on the expiry, so expiry and absence are the same answer here.
    const { app, store } = await harness({ known: false, registered: false });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(store.create).not.toHaveBeenCalled();
  });

  it('refuses a malformed contract id', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/not-a-contract/invites`,
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('forbids caching the code', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: {},
    });

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses an authenticated user with 429 when exceeding their invite creation budget', async () => {
    const { app, store } = await harness();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
        headers: AUTH,
        payload: {},
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 20).every((status) => status === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect(store.create).toHaveBeenCalledTimes(20);
  });

  it('refuses an authenticated user exceeding their budget across distinct IP addresses', async () => {
    const { app, store } = await harness();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
        headers: AUTH,
        remoteAddress: `198.51.100.${attempt + 1}`,
        payload: {},
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 20).every((status) => status === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect(store.create).toHaveBeenCalledTimes(20);
  });

  it('isolates invite creation budgets between distinct authenticated users', async () => {
    const { app, store } = await harness();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
        headers: { authorization: 'Bearer user-alice' },
        payload: {},
      });
      expect(response.statusCode).toBe(201);
    }

    const aliceBlocked = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: { authorization: 'Bearer user-alice' },
      payload: {},
    });
    expect(aliceBlocked.statusCode).toBe(429);

    const bobResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: { authorization: 'Bearer user-bob' },
      payload: {},
    });
    expect(bobResponse.statusCode).toBe(201);
    expect(store.create).toHaveBeenCalledTimes(21);
  });
});

describe('POST /api/v1/invites/redeem', () => {
  it('refuses an unauthenticated request', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(401);
  });

  it('redeems a code for the authenticated user', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      groupContractId: GROUP_CONTRACT_ID,
      inviteId: 'invite-id',
    });
    // The user is the token's, never the body's. The store is not told which
    // group: the code names it, which is what lets an invite link work without
    // carrying an address.
    // The store is also asked whether this redemption should spend a use. The
    // answer is exercised in its own block below; here only the call shape matters.
    expect(store.redeem).toHaveBeenCalledWith({
      code: CODE,
      userId: USER_ID,
      shouldClaim: expect.any(Function),
    });
  });

  it('needs no group address, because the code identifies the group', async () => {
    const { app, store } = await harness();

    // The code is the whole request. An invite link carries a code and nothing
    // else, so a redemption that required a contract id could never be made from
    // one.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(200);
    expect(store.redeem).toHaveBeenCalledTimes(1);
  });

  it('reports the group the code admits to', async () => {
    const store = fakeStore();
    store.redeem = vi.fn(
      async () =>
        ({
          outcome: 'redeemed',
          inviteId: 'invite-id',
          groupContractId: OTHER_CONTRACT_ID,
        }) as RedeemOutcome,
    );
    const { app } = await harness({ store });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: CODE },
    });

    // The caller has no other way to learn it, and needs it to send the on-chain
    // join.
    expect(response.json().data.groupContractId).toBe(OTHER_CONTRACT_ID);
  });

  it('refuses a code shaped like a Stellar address without a lookup', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: `C${'A'.repeat(55)}` },
    });

    expect(response.statusCode).toBe(404);
    // Refused on shape, so junk codes do not become indexed lookups.
    expect(store.redeem).not.toHaveBeenCalled();
  });

  it('refuses a code that is too short without a lookup', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: 'short' },
    });

    expect(response.statusCode).toBe(404);
    expect(store.redeem).not.toHaveBeenCalled();
  });

  it('reports an unknown, expired or revoked code identically', async () => {
    // One answer for all three. Any distinction would confirm that a guessed
    // code is real, which is the one thing an unguessable code must not reveal.
    for (const outcome of ['not_found', 'expired', 'revoked'] as const) {
      const store = fakeStore();
      store.redeem = vi.fn(async () => ({ outcome }) as RedeemOutcome);
      const { app } = await harness({ store });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/invites/redeem',
        headers: AUTH,
        payload: { code: CODE },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'invite_not_found' });
    }
  });

  it('reports an exhausted code distinctly', async () => {
    const store = fakeStore();
    store.redeem = vi.fn(async () => ({ outcome: 'exhausted' }) as RedeemOutcome);
    const { app } = await harness({ store });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: CODE },
    });

    // Distinct from not_found because the caller did nothing wrong and a fresh
    // invite is a real remedy.
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'invite_exhausted' });
  });

  it('succeeds twice for the same user, because redemption is idempotent', async () => {
    const { app, store } = await harness();

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: CODE },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: CODE },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(store.redeem).toHaveBeenCalledTimes(2);
  });

  it('refuses a missing code', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('does not leak the code into a cacheable response', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: CODE },
    });

    // The response names the group rather than echoing the code, so a shared
    // cache never holds the secret.
    expect(response.json().data.code).toBeUndefined();
  });
});
describe('POST /api/v1/groups/:contractId/join', () => {
  it('refuses an unauthenticated request', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/join`,
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(401);
    expect(store.redeem).not.toHaveBeenCalled();
  });

  it('redeems a code for the authenticated user', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/join`,
      headers: AUTH,
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      groupContractId: GROUP_CONTRACT_ID,
      inviteId: 'invite-id',
    });
    // The store is also asked whether this redemption should spend a use. The
    // answer is exercised in its own block below; here only the call shape matters.
    expect(store.redeem).toHaveBeenCalledWith({
      code: CODE,
      userId: USER_ID,
      shouldClaim: expect.any(Function),
    });
  });

  it('reports a code for a different group as absent', async () => {
    const store = fakeStore();
    store.redeem = vi.fn(
      async () =>
        ({
          outcome: 'redeemed',
          inviteId: 'invite-id',
          groupContractId: OTHER_CONTRACT_ID,
        }) as RedeemOutcome,
    );
    const { app } = await harness({ store });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/join`,
      headers: AUTH,
      payload: { code: CODE },
    });

    // The whole reason this shape exists: a client whose code and group came from
    // different places gets told, rather than being quietly joined to the other
    // group. Reported as absent rather than as a mismatch, so it confirms nothing
    // about the code.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'invite_not_found' });
  });

  it('accepts a code whose group matches the path', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/join`,
      headers: AUTH,
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(200);
  });

  it('refuses a malformed contract id without a lookup', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/groups/not-a-contract/join',
      headers: AUTH,
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(400);
    expect(store.redeem).not.toHaveBeenCalled();
  });

  it('reports an exhausted code distinctly, as the code-scoped shape does', async () => {
    const store = fakeStore();
    store.redeem = vi.fn(async () => ({ outcome: 'exhausted' }) as RedeemOutcome);
    const { app } = await harness({ store });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/join`,
      headers: AUTH,
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'invite_exhausted' });
  });
});

/**
 * Whether redeeming spends a use of the invite.
 *
 * A code can outlive the window it was made for: the group fills up, somebody
 * calls `start`, and the link keeps circulating. The chain refuses a join unless
 * the group is still `open`, so spending a use on that code bills the visitor for
 * something that could never have worked.
 *
 * What is tested here is only the decision the route hands the store. That the
 * decision is honoured - nothing written, no use spent - is a property of the
 * store, and is checked against a real Postgres in `invite-store.test.ts`.
 */
describe('whether a redemption should claim a use', () => {
  /** The `shouldClaim` the route passed to the store on its first redemption. */
  function claimCheck(store: FakeStore): (groupContractId: string) => Promise<boolean> {
    const [argument] = store.redeem.mock.calls[0] as [
      { shouldClaim: (groupContractId: string) => Promise<boolean> },
    ];
    return argument.shouldClaim;
  }

  /** Redeems once against a read model that reports `status`, and returns the check. */
  async function checkAgainst(status: GroupStatus | undefined): Promise<{
    shouldClaim: (groupContractId: string) => Promise<boolean>;
    groupStatus: ReturnType<typeof vi.fn>;
  }> {
    const { app, store, groupStatus } = await harness({ status });

    await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: CODE },
    });

    return { shouldClaim: claimCheck(store), groupStatus };
  }

  it('claims while the group is still open', async () => {
    const { shouldClaim } = await checkAgainst('open');
    expect(await shouldClaim(GROUP_CONTRACT_ID)).toBe(true);
  });

  it('claims when the index has not seen the group yet', async () => {
    // The creator's own case, and the one that would break inviting if this were
    // wrong: a group is registered the moment it is created, and the indexer
    // trails by up to a run. "Not known" must not read as "not open".
    const { shouldClaim, groupStatus } = await checkAgainst(undefined);

    expect(await shouldClaim(GROUP_CONTRACT_ID)).toBe(true);
    // Asked about the group, not left to guess: the answer depends on which group
    // the code resolves to, which only the store knows.
    expect(groupStatus).toHaveBeenCalledWith(GROUP_CONTRACT_ID);
  });

  it('withholds the claim once the group has started', async () => {
    const { shouldClaim } = await checkAgainst('active');
    expect(await shouldClaim(GROUP_CONTRACT_ID)).toBe(false);
  });

  it('withholds the claim once every round has paid out', async () => {
    const { shouldClaim } = await checkAgainst('completed');
    expect(await shouldClaim(GROUP_CONTRACT_ID)).toBe(false);
  });
});
