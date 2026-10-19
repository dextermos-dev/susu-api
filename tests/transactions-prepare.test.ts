import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  Account,
  Contract,
  Keypair,
  StrKey,
  TransactionBuilder,
  rpc,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import type { GroupReadModel } from '../src/db/groups';
import type { RegistrationStore } from '../src/db/registrations';
import type { TokenVerifier } from '../src/auth/verify';
import { configureTestEnv } from './support/fixtures';

/**
 * `POST /transactions/prepare`: simulate an invocation the client built, and hand
 * back the same call with a footprint and fee.
 *
 * The tests here are about the shape of the contract with the client: it is
 * authenticated, it only simulates the protocol's own contracts, it reports a
 * contract's refusal as an answer rather than a transport error, and — the one
 * property everything else rests on — what it returns is the caller's own call.
 */

configureTestEnv();

const USER_ID = '11111111-1111-1111-1111-111111111111';
const AUTH = { authorization: 'Bearer a-good-token' };
const SOURCE = Keypair.random().publicKey();

/**
 * Real contract addresses, derived rather than hand-written.
 *
 * The shared fixtures use `C` followed by repeated characters, which is the right
 * shape but not a valid checksum, so the SDK refuses to build a call against them.
 * Here the envelope has to be one the SDK would actually produce.
 */
const GROUP = StrKey.encodeContract(Buffer.alloc(32, 1));
const OTHER = StrKey.encodeContract(Buffer.alloc(32, 2));

const built: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(built.splice(0).map(async (app) => app.close()));
});

/** An unsigned envelope invoking one method, as the web app would build it. */
function envelopeXdr(contractId: string, method: string): string {
  return new TransactionBuilder(new Account(SOURCE, '0'), {
    fee: '100',
    networkPassphrase: 'Test SDF Network ; September 2015',
  })
    .addOperation(new Contract(contractId).call(method))
    .setTimeout(60)
    .build()
    .toXDR();
}

/** A simulation success in the raw JSON-RPC shape, so assembly is the SDK's own. */
function simulationSuccess(resourceFee: number): rpc.Api.SimulateTransactionResponse {
  const transactionData = new xdr.SorobanTransactionData({
    ext: xdr.SorobanTransactionDataExt.v0(),
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
      instructions: 0,
      diskReadBytes: 0,
      writeBytes: 0,
    }),
    resourceFee: BigInt(resourceFee),
  });

  return {
    latestLedger: 1,
    transactionData: transactionData.toXDR('base64'),
    minResourceFee: String(resourceFee),
    results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR('base64') }],
    events: [],
    stateChanges: [],
    id: 1,
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

function simulationFailure(error: string): rpc.Api.SimulateTransactionResponse {
  return { latestLedger: 1, id: 1, error } as unknown as rpc.Api.SimulateTransactionResponse;
}

type HarnessOptions = {
  simulate?: (transaction: unknown) => Promise<rpc.Api.SimulateTransactionResponse>;
  simulateTimeoutMs?: number;
  /** Whether the index knows this address as a group. */
  knownGroup?: string;
  /** Whether a just-created address was registered before the index caught up. */
  registered?: boolean;
  verify?: TokenVerifier;
};

async function harness(options: HarnessOptions = {}): Promise<{
  app: FastifyInstance;
  simulate: ReturnType<typeof vi.fn>;
  groupExists: ReturnType<typeof vi.fn>;
  isRegistered: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
}> {
  const { buildServer } = await import('../src/server');
  const verify = vi.fn(options.verify ?? (async () => ({ id: USER_ID, email: 'ada@example.com' })));

  const simulate = vi.fn(options.simulate ?? (async () => simulationSuccess(150)));
  const groupExists = vi.fn(async (contractId: string) => contractId === options.knownGroup);
  const isRegistered = vi.fn(async () => options.registered ?? false);

  const app = await buildServer({
    probeDatabase: async () => {},
    verifyToken: verify as unknown as TokenVerifier,
    sorobanSimulator: simulate as never,
    simulateTimeoutMs: options.simulateTimeoutMs,
    readModel: {
      groupExists,
      listGroups: vi.fn(),
      getGroup: vi.fn(),
      listContributions: vi.fn(),
      listPayouts: vi.fn(),
      listActivity: vi.fn(),
    } as unknown as GroupReadModel,
    registrations: {
      register: vi.fn(),
      isRegistered,
    } as unknown as RegistrationStore,
  });
  built.push(app);

  return { app, simulate, groupExists, isRegistered, verify };
}

describe('POST /api/v1/transactions/prepare', () => {
  it('refuses an unauthenticated request without simulating anything', async () => {
    const { app, simulate } = await harness({ knownGroup: GROUP });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/prepare',
      payload: { transactionXdr: envelopeXdr(GROUP, 'contribute') },
    });

    expect(response.statusCode).toBe(401);
    // An open simulation endpoint is free compute for whoever finds it, so the
    // refusal has to come before the RPC call, not after.
    expect(simulate).not.toHaveBeenCalled();
  });

  it("returns the caller's own call, assembled and still unsigned", async () => {
    const { app } = await harness({ knownGroup: GROUP });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/prepare',
      headers: AUTH,
      payload: { transactionXdr: envelopeXdr(GROUP, 'contribute') },
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data as {
      status: string;
      contractId: string;
      method: string;
      preparedXdr: string;
    };
    expect(data.status).toBe('prepared');
    expect(data.contractId).toBe(GROUP);
    expect(data.method).toBe('contribute');

    // The envelope that comes back is one the client can sign: same source, same
    // single call, no signatures added by the server.
    const prepared = TransactionBuilder.fromXDR(
      data.preparedXdr,
      'Test SDF Network ; September 2015',
    ) as Transaction;
    expect(prepared.source).toBe(SOURCE);
    expect(prepared.signatures).toHaveLength(0);
    expect(prepared.operations).toHaveLength(1);
  });

  it('gives each caller their own simulation budget', async () => {
    // `prepare` spends this service's RPC quota, so it carries a budget of its
    // own rather than a share of the global one: a single budget of 100 a minute
    // means one caller exhausting it refuses everybody else, while a caller with
    // a second session is not slowed at all.
    const { app, simulate } = await harness({ knownGroup: GROUP });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/transactions/prepare',
        headers: AUTH,
        payload: { transactionXdr: envelopeXdr(GROUP, 'contribute') },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses[20]).toBe(429);

    // The refusal is about the caller's budget, not about the envelope: the
    // calls that were allowed all reached the simulator, and the one that was
    // refused did not.
    expect(simulate).toHaveBeenCalledTimes(20);
  });

  it('refuses rotating-token callers after the budget and stops invoking token verification', async () => {
    const { app, verify, simulate } = await harness({ knownGroup: GROUP });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/transactions/prepare',
        headers: { authorization: `Bearer rotating-token-${attempt}` },
        payload: { transactionXdr: envelopeXdr(GROUP, 'contribute') },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses[20]).toBe(429);

    // Token verification and simulation must be invoked at most N times (20)
    expect(verify).toHaveBeenCalledTimes(20);
    expect(simulate).toHaveBeenCalledTimes(20);
  });

  it('refuses unauthenticated callers sending distinct Bearer values after the budget', async () => {
    const unauthVerify = vi.fn(async () => undefined);
    const { app, simulate } = await harness({
      knownGroup: GROUP,
      verify: unauthVerify as unknown as TokenVerifier,
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/transactions/prepare',
        headers: { authorization: `Bearer junk-token-${attempt}` },
        payload: { transactionXdr: envelopeXdr(GROUP, 'contribute') },
      });
      statuses.push(response.statusCode);
    }

    // The first 20 requests are refused with 401 because tokens are invalid
    expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
    // The 21st request is refused with 429 because the budget is exhausted
    expect(statuses[20]).toBe(429);

    // verifyToken must be invoked at most 20 times (never for the 21st request)
    expect(unauthVerify).toHaveBeenCalledTimes(20);
    expect(simulate).not.toHaveBeenCalled();
  });

  it('refuses an authenticated user exceeding their budget across distinct IP addresses', async () => {
    const { app, simulate } = await harness({ knownGroup: GROUP });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/transactions/prepare',
        headers: AUTH,
        remoteAddress: `198.51.100.${attempt + 1}`,
        payload: { transactionXdr: envelopeXdr(GROUP, 'contribute') },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect(simulate).toHaveBeenCalledTimes(20);
  });

  it('never stores a prepared envelope', async () => {
    const { app } = await harness({ knownGroup: GROUP });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/prepare',
      headers: AUTH,
      payload: { transactionXdr: envelopeXdr(GROUP, 'contribute') },
    });

    // A resource footprint belongs to one simulation against one ledger; a shared
    // cache serving it to another caller would be serving a stale answer.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses a registration-only address: unverified claims cannot simulate', async () => {
    // Registrations are unverified claims — anyone can register any shape-valid
    // address. Letting them through the prepare allowlist would turn the
    // endpoint into an open simulation proxy paid for by this service, so the
    // allowlist consults the index only. Registrations stay scoped to invite
    // creation.
    const { app, simulate, groupExists, isRegistered } = await harness({ registered: true });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/prepare',
      headers: AUTH,
      payload: { transactionXdr: envelopeXdr(OTHER, 'contribute') },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'contract_not_allowed' });
    expect(groupExists).toHaveBeenCalledWith(OTHER);
    // The registration store is never consulted for the prepare allowlist, and
    // the simulator is never reached.
    expect(isRegistered).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
  });

  it('refuses to simulate a contract that is not one of ours', async () => {
    const { app, simulate } = await harness({ knownGroup: GROUP });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/prepare',
      headers: AUTH,
      payload: { transactionXdr: envelopeXdr(OTHER, 'transfer') },
    });

    // Without this the endpoint is an open simulation proxy for any contract on
    // the network, paid for by this service.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'contract_not_allowed' });
    expect(simulate).not.toHaveBeenCalled();
  });

  it("reports a contract's refusal as an answer, with its raw error", async () => {
    const { app } = await harness({
      knownGroup: GROUP,
      simulate: async () => simulationFailure('HostError: Error(Contract, #5)'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/prepare',
      headers: AUTH,
      payload: { transactionXdr: envelopeXdr(GROUP, 'contribute') },
    });

    // Not an HTTP error: the request was well-formed and the server did its job.
    // The contract said no, and the client owns the table that explains why.
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      status: 'refused',
      contractId: GROUP,
      method: 'contribute',
      rawError: 'HostError: Error(Contract, #5)',
    });
  });

  it('reports an expired footprint as a restore rather than a failure', async () => {
    const success = simulationSuccess(150);
    const { app } = await harness({
      knownGroup: GROUP,
      simulate: async () =>
        ({
          ...success,
          restorePreamble: { minResourceFee: '100', transactionData: 'AAAA' },
        }) as never,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/prepare',
      headers: AUTH,
      payload: { transactionXdr: envelopeXdr(GROUP, 'contribute') },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('restore_required');
  });

  it('refuses a body that is not an envelope', async () => {
    const { app, simulate } = await harness({ knownGroup: GROUP });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/prepare',
      headers: AUTH,
      payload: { transactionXdr: 'not-an-envelope' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'malformed_envelope' });
    expect(simulate).not.toHaveBeenCalled();
  });

  it('refuses a body with no envelope at all', async () => {
    const { app, simulate } = await harness({ knownGroup: GROUP });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/prepare',
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(simulate).not.toHaveBeenCalled();
  });

  it('refuses an oversized body before parsing it', async () => {
    const { app, simulate } = await harness({ knownGroup: GROUP });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/prepare',
      headers: AUTH,
      payload: { transactionXdr: 'A'.repeat(20_000) },
    });

    expect(response.statusCode).toBe(400);
    expect(simulate).not.toHaveBeenCalled();
  });

  it('refuses a transaction with more than one operation', async () => {
    const { app, simulate } = await harness({ knownGroup: GROUP });

    const twoOps = new TransactionBuilder(new Account(SOURCE, '0'), {
      fee: '100',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })
      .addOperation(new Contract(GROUP).call('contribute'))
      .addOperation(new Contract(GROUP).call('payout'))
      .setTimeout(60)
      .build()
      .toXDR();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/prepare',
      headers: AUTH,
      payload: { transactionXdr: twoOps },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'not_a_single_invocation' });
    expect(simulate).not.toHaveBeenCalled();
  });

  it('maps a simulation exceeding the configured deadline to 503 upstream_unavailable', async () => {
    const { app } = await harness({
      knownGroup: GROUP,
      // Never-resolving simulator testing timeout boundary
      simulate: () => new Promise<rpc.Api.SimulateTransactionResponse>(() => {}),
      simulateTimeoutMs: 50,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/prepare',
      headers: AUTH,
      payload: { transactionXdr: envelopeXdr(GROUP, 'contribute') },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'upstream_unavailable' });
  });

  it('maps a simulator transport error to 502 upstream_unavailable', async () => {
    const { app } = await harness({
      knownGroup: GROUP,
      simulate: async () => {
        throw new Error('socket hang up');
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/prepare',
      headers: AUTH,
      payload: { transactionXdr: envelopeXdr(GROUP, 'contribute') },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'upstream_unavailable' });
  });
});
