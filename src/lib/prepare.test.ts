/**
 * Tests for invocation preparation.
 *
 * These drive the real SDK: envelopes are built with `Contract.call`, simulation
 * responses are the raw JSON-RPC shape, and assembly is the SDK's own
 * `assembleTransaction`. Nothing is stubbed, because the property under test is
 * that this service hands back the caller's own call unchanged — a stub standing
 * in for the SDK would be testing the stub. It also means these tests fail if the
 * SDK's XDR accessors change shape, which is exactly what happened when this was
 * first written (the newer codegen has no `switch()`).
 */
import {
  Account,
  Asset,
  Contract,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  rpc,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_ENVELOPE_LENGTH,
  keepsInvocation,
  parseInvocationEnvelope,
  prepareInvocation,
  type InvocationEnvelope,
} from './prepare';

const PASSPHRASE = 'Test SDF Network ; September 2015';
const OTHER_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/** A syntactically valid contract address, distinct per seed. */
function contractAddress(seed: number): string {
  return StrKey.encodeContract(Buffer.alloc(32, seed));
}

const GROUP = contractAddress(7);
const OTHER_GROUP = contractAddress(9);
const SOURCE = Keypair.random().publicKey();
const OTHER_SOURCE = Keypair.random().publicKey();

type EnvelopeOptions = {
  contractId?: string;
  method?: string;
  source?: string;
  passphrase?: string;
  operations?: (builder: TransactionBuilder) => TransactionBuilder;
};

function buildEnvelope(options: EnvelopeOptions = {}): string {
  const builder = new TransactionBuilder(new Account(options.source ?? SOURCE, '0'), {
    fee: '100',
    networkPassphrase: options.passphrase ?? PASSPHRASE,
  });

  const withOperations =
    options.operations?.(builder) ??
    builder.addOperation(
      new Contract(options.contractId ?? GROUP).call(options.method ?? 'contribute'),
    );

  return withOperations.setTimeout(60).build().toXDR();
}

/** Parses, failing loudly if the fixture was refused. */
function asEnvelope(envelopeXdr: string, passphrase = PASSPHRASE): InvocationEnvelope {
  const parsed = parseInvocationEnvelope(envelopeXdr, passphrase);
  if (typeof parsed === 'string') throw new Error(`fixture refused: ${parsed}`);
  return parsed;
}

/**
 * A `SorobanTransactionData` in the base64 form RPC returns it.
 *
 * `parseRawSimulation` is what the SDK applies to this, so building the typed
 * object and serialising it exercises the same path a real response takes.
 */
function transactionDataXdr(resourceFee: number): string {
  return new xdr.SorobanTransactionData({
    ext: xdr.SorobanTransactionDataExt.v0(),
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
      instructions: 0,
      diskReadBytes: 0,
      writeBytes: 0,
    }),
    resourceFee: BigInt(resourceFee),
  }).toXDR('base64');
}

function simulationSuccess(resourceFee: number): rpc.Api.SimulateTransactionResponse {
  return {
    latestLedger: 1,
    transactionData: transactionDataXdr(resourceFee),
    minResourceFee: String(resourceFee),
    results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR('base64') }],
    events: [],
    stateChanges: [],
    id: 1,
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

const ALLOWED = async (): Promise<boolean> => true;
const DENIED = async (): Promise<boolean> => false;

describe('parseInvocationEnvelope', () => {
  it('reads the contract and method out of a single invocation', () => {
    const envelope = asEnvelope(buildEnvelope({ method: 'join' }));

    expect(envelope.contractId).toBe(GROUP);
    expect(envelope.method).toBe('join');
    expect(envelope.transaction.source).toBe(SOURCE);
  });

  it('accepts an envelope built for another network, because a network is not in the envelope', () => {
    // Documents a real property of Stellar rather than a choice made here: the
    // network id lives in the signature base, not in the transaction, so there is
    // nothing to compare and no network to refuse. What binds the result is the
    // passphrase this service assembles with.
    const envelope = buildEnvelope({ passphrase: OTHER_PASSPHRASE });
    const parsed = asEnvelope(envelope);

    expect(parsed.contractId).toBe(GROUP);
    expect(parsed.transaction.networkPassphrase).toBe(PASSPHRASE);
  });

  it('refuses a string that is not an envelope at all', () => {
    expect(parseInvocationEnvelope('not-xdr', PASSPHRASE)).toBe('malformed_envelope');
    expect(parseInvocationEnvelope('', PASSPHRASE)).toBe('malformed_envelope');
  });

  it('refuses more than one operation', () => {
    // One intent per request, so the user reviews one thing before signing.
    const envelope = buildEnvelope({
      operations: (builder) =>
        builder
          .addOperation(new Contract(GROUP).call('contribute'))
          .addOperation(new Contract(GROUP).call('payout')),
    });

    expect(parseInvocationEnvelope(envelope, PASSPHRASE)).toBe('not_a_single_invocation');
  });

  it('refuses a single operation that is not a contract invocation', () => {
    const envelope = buildEnvelope({
      operations: (builder) =>
        builder.addOperation(
          Operation.payment({
            destination: OTHER_SOURCE,
            asset: Asset.native(),
            amount: '1',
          }),
        ),
    });

    expect(parseInvocationEnvelope(envelope, PASSPHRASE)).toBe('not_an_invocation');
  });

  it('refuses a host function that does not call a contract', () => {
    // Uploading wasm is a host function, but no contract is being called, so there
    // is nothing here that an allow-list could permit.
    const envelope = buildEnvelope({
      operations: (builder) =>
        builder.addOperation(Operation.uploadContractWasm({ wasm: Buffer.from([0, 1, 2]) })),
    });

    expect(parseInvocationEnvelope(envelope, PASSPHRASE)).toBe('not_an_invocation');
  });
});

describe('prepareInvocation', () => {
  it("returns the caller's own call once simulated, with the resource fee added", async () => {
    const simulate = vi.fn(async () => simulationSuccess(150));

    const outcome = await prepareInvocation({
      envelopeXdr: buildEnvelope({ method: 'contribute' }),
      networkPassphrase: PASSPHRASE,
      simulate,
      isAllowedContract: ALLOWED,
    });

    expect(outcome.status).toBe('prepared');
    if (outcome.status !== 'prepared') return;
    expect(outcome.contractId).toBe(GROUP);
    expect(outcome.method).toBe('contribute');

    // The point of the endpoint: the same call, same source, still unsigned. Only
    // resources and fee were added.
    const reparsed = asEnvelope(outcome.preparedXdr);
    expect(reparsed.contractId).toBe(GROUP);
    expect(reparsed.method).toBe('contribute');
    expect(reparsed.transaction.source).toBe(SOURCE);
    expect(reparsed.transaction.signatures).toHaveLength(0);

    // 100 classic + 150 resource.
    expect(reparsed.transaction.fee).toBe('250');
  });

  it("passes the caller's transaction to the simulator unmodified", async () => {
    const simulate = vi.fn(async (_transaction: Transaction) => simulationSuccess(150));

    await prepareInvocation({
      envelopeXdr: buildEnvelope({}),
      networkPassphrase: PASSPHRASE,
      simulate,
      isAllowedContract: ALLOWED,
    });

    expect(simulate).toHaveBeenCalledTimes(1);
    const simulated = simulate.mock.calls[0]?.[0];
    expect(simulated?.source).toBe(SOURCE);
    expect(simulated?.operations).toHaveLength(1);
  });

  it("refuses a contract that is not the protocol's, without simulating it", async () => {
    const simulate = vi.fn(async () => simulationSuccess(150));

    const outcome = await prepareInvocation({
      envelopeXdr: buildEnvelope({ contractId: OTHER_GROUP }),
      networkPassphrase: PASSPHRASE,
      simulate,
      isAllowedContract: DENIED,
    });

    expect(outcome).toEqual({ status: 'invalid', reason: 'contract_not_allowed' });
    // The allow-list exists to keep this from being an open simulation proxy, so a
    // refusal must not have cost an RPC call.
    expect(simulate).not.toHaveBeenCalled();
  });

  it('reports a contract refusal with the raw error', async () => {
    const simulate = vi.fn(
      async () =>
        ({
          latestLedger: 1,
          id: 1,
          error: 'HostError: Error(Contract, #5)',
        }) as unknown as rpc.Api.SimulateTransactionResponse,
    );

    const outcome = await prepareInvocation({
      envelopeXdr: buildEnvelope({}),
      networkPassphrase: PASSPHRASE,
      simulate,
      isAllowedContract: ALLOWED,
    });

    expect(outcome).toEqual({
      status: 'refused',
      contractId: GROUP,
      method: 'contribute',
      rawError: 'HostError: Error(Contract, #5)',
    });
  });

  it('reports an expired footprint as a restore, not a refusal', async () => {
    // Only the presence of a restore preamble matters here: this path is not
    // assembled, it is reported, because the remedy is a separate transaction.
    const simulate = vi.fn(
      async () =>
        ({
          latestLedger: 1,
          id: 1,
          transactionData: transactionDataXdr(100),
          minResourceFee: '100',
          restorePreamble: { minResourceFee: '100', transactionData: transactionDataXdr(100) },
        }) as unknown as rpc.Api.SimulateTransactionResponse,
    );

    const outcome = await prepareInvocation({
      envelopeXdr: buildEnvelope({}),
      networkPassphrase: PASSPHRASE,
      simulate,
      isAllowedContract: ALLOWED,
    });

    expect(outcome).toEqual({
      status: 'restore_required',
      contractId: GROUP,
      method: 'contribute',
    });
  });

  it('refuses an envelope it cannot parse before spending an RPC call', async () => {
    const simulate = vi.fn(async () => simulationSuccess(150));

    const outcome = await prepareInvocation({
      envelopeXdr: buildEnvelope({
        operations: (builder) =>
          builder
            .addOperation(new Contract(GROUP).call('contribute'))
            .addOperation(new Contract(GROUP).call('payout')),
      }),
      networkPassphrase: PASSPHRASE,
      simulate,
      isAllowedContract: ALLOWED,
    });

    expect(outcome).toEqual({ status: 'invalid', reason: 'not_a_single_invocation' });
    expect(simulate).not.toHaveBeenCalled();
  });

  it('does not mistake an unrecognised response for a success', async () => {
    // A response with none of the three markers. It must not be read as a success,
    // and it must not crash the request either.
    const simulate = vi.fn(
      async () => ({ latestLedger: 1, id: 1 }) as unknown as rpc.Api.SimulateTransactionResponse,
    );

    const outcome = await prepareInvocation({
      envelopeXdr: buildEnvelope({}),
      networkPassphrase: PASSPHRASE,
      simulate,
      isAllowedContract: ALLOWED,
    });

    expect(outcome).toEqual({ status: 'unrecognized', contractId: GROUP, method: 'contribute' });
  });

  it('maps a simulation exceeding the configured deadline to upstream_failed with timeout reason', async () => {
    // A simulator that never resolves, testing the timeout boundary
    const simulate = vi.fn(() => new Promise<rpc.Api.SimulateTransactionResponse>(() => {}));

    const outcome = await prepareInvocation({
      envelopeXdr: buildEnvelope({}),
      networkPassphrase: PASSPHRASE,
      simulate,
      isAllowedContract: ALLOWED,
      simulateTimeoutMs: 25,
    });

    expect(outcome).toEqual({
      status: 'upstream_failed',
      reason: 'timeout',
      contractId: GROUP,
      method: 'contribute',
    });
  });

  it('maps simulator transport rejections to upstream_failed with transport reason', async () => {
    const simulate = vi.fn(async () => {
      throw new Error('connection reset by peer');
    });

    const outcome = await prepareInvocation({
      envelopeXdr: buildEnvelope({}),
      networkPassphrase: PASSPHRASE,
      simulate,
      isAllowedContract: ALLOWED,
    });

    expect(outcome).toEqual({
      status: 'upstream_failed',
      reason: 'transport',
      contractId: GROUP,
      method: 'contribute',
    });
  });
});

describe('keepsInvocation', () => {
  const original = asEnvelope(buildEnvelope({ method: 'contribute' }));

  it('accepts the same call from the same account', () => {
    expect(keepsInvocation(original, asEnvelope(buildEnvelope({ method: 'contribute' })))).toBe(
      true,
    );
  });

  it('rejects a different contract, a different method, or a different source', () => {
    const candidates = [
      buildEnvelope({ contractId: OTHER_GROUP, method: 'contribute' }),
      buildEnvelope({ method: 'payout' }),
      buildEnvelope({ source: OTHER_SOURCE, method: 'contribute' }),
    ];

    for (const candidate of candidates) {
      expect(keepsInvocation(original, asEnvelope(candidate))).toBe(false);
    }
  });
});

describe('MAX_ENVELOPE_LENGTH', () => {
  it('is far below what a non-invocation would need to be refused', () => {
    // Documents the reasoning: an un-simulated invocation is small, so a cap that
    // allowed megabytes would only let this endpoint be used to burn request
    // buffers.
    expect(MAX_ENVELOPE_LENGTH).toBeLessThanOrEqual(16 * 1024);
    expect(buildEnvelope({}).length).toBeLessThan(MAX_ENVELOPE_LENGTH);
  });
});
