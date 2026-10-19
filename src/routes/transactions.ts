/**
 * Transaction endpoints.
 *
 * Two different things live here, and they are deliberately not symmetrical:
 *
 *   * `GET /transactions/:txHash` is public, like the group routes. Everything it
 *     returns is chain-derived and already visible to anyone reading the ledger,
 *     so there is nothing to authenticate.
 *   * `POST /transactions/prepare` is authenticated, because it spends this
 *     service's RPC quota on behalf of the caller and because an anonymous
 *     simulation endpoint is free compute for anyone who finds it.
 *
 * Neither of them signs, submits, or holds a key. Preparation fills in a footprint
 * and a fee; the wallet signs; the client submits.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticatedUser } from '../auth/guard';
import {
  isTransactionHash,
  normaliseTransactionHash,
  type TransactionReadModel,
} from '../db/transactions';
import { MAX_ENVELOPE_LENGTH, prepareInvocation, type PrepareOutcome } from '../lib/prepare';
import type { SorobanSimulator } from '../lib/soroban';
import { invalidRequest } from './errors';

export type TransactionRoutesOptions = {
  readModel: TransactionReadModel;
  /** The authenticated-route guard. Injected, as elsewhere, for testability. */
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  simulate: SorobanSimulator;
  isAllowedContract: (contractId: string) => Promise<boolean>;
  networkPassphrase: string;
  simulateTimeoutMs?: number;
};

/**
 * A receipt is immutable: a transaction's events are decided when it is included
 * in a ledger and never change afterwards. So this is the one response in the API
 * that can be cached with confidence — but only the *found* one.
 *
 * `not found` is the opposite. The indexer runs on a schedule, so for a
 * transaction submitted moments ago it means "not yet", and caching that would
 * turn a transient state into a sticky one for as long as the cache lives. The
 * two get different headers for that reason.
 */
const FOUND_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=600';
const ABSENT_CACHE_CONTROL = 'no-store';

/**
 * The body is an envelope, not an intent.
 *
 * That is the whole security shape of this endpoint: the client decides what the
 * transaction does, and this service may only make it valid. An intent-shaped body
 * would put this service in the position of deciding an operation's contract,
 * method and arguments, which is financial authority the backend is not allowed to
 * have.
 *
 * The length cap is well below the global body limit for a reason: an envelope
 * that has not been simulated yet carries no footprint, so a legitimate one is a
 * few hundred bytes. Anything near a kilobyte is not an unsigned invocation.
 */
const prepareBody = z.object({
  transactionXdr: z.string().min(1).max(MAX_ENVELOPE_LENGTH, 'envelope is too large'),
});

/**
 * Rate limit configuration for `/transactions/prepare`.
 *
 * A budget for `/prepare` of the caller's own, rather than a share of everyone's.
 * This is the one route that spends the service's RPC quota.
 *
 * An unauthenticated caller must not be able to bypass rate limits by rotating
 * unverified Bearer tokens to hammer Supabase/token verification. Therefore, the route
 * enforces an IP-level rate limit at the transport (onRequest) layer before the auth guard.
 * In addition, verified callers are rate-limited on their authenticated user ID in
 * preHandler after authentication, so that a caller cannot exceed their simulation budget
 * across multiple sessions or rotating IP addresses.
 */
const PREPARE_RATE_LIMIT = {
  max: 20,
  timeWindow: '1 minute',
  keyGenerator: (request: FastifyRequest): string => `ip:${request.ip}`,
} as const;

export async function transactionRoutes(
  app: FastifyInstance,
  options: TransactionRoutesOptions,
): Promise<void> {
  const { readModel, requireAuth, simulate, isAllowedContract, networkPassphrase } = options;

  const verifiedUserLimiter = app.createRateLimit({
    max: 20,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest): string => {
      const user = request.user;
      return user ? `user:${user.id}` : `ip:${request.ip}`;
    },
  });

  app.get('/transactions/:txHash', async (request, reply) => {
    const params = request.params as { txHash?: unknown };
    const txHash = params.txHash;

    // A hash that is not 64 hex characters cannot match a row, so it is refused
    // before the query rather than after: a junk path segment should not become a
    // database lookup, and cannot be used to probe for stored values.
    if (typeof txHash !== 'string' || !isTransactionHash(txHash)) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const receipt = await readModel.getReceipt(normaliseTransactionHash(txHash));

    if (receipt === undefined) {
      // Deliberately indistinguishable from "this transaction did no Susu work":
      // the index cannot tell the two apart, so neither can this.
      reply.header('cache-control', ABSENT_CACHE_CONTROL);
      return reply.code(404).send({ error: 'transaction_not_found' });
    }

    reply.header('cache-control', FOUND_CACHE_CONTROL);
    return reply.send({ data: receipt });
  });

  /**
   * Simulates an invocation and returns it assembled, ready to sign.
   *
   * The client builds; this fills in the resource footprint and fee the protocol
   * requires, after the contract has had the chance to refuse the call. That order
   * is the document's: validate and simulate *before* the user is asked to approve
   * anything.
   *
   * A refused call is `200` with a `refused` status rather than an HTTP error. The
   * request was well-formed and the server did its job; the contract said no, which
   * is an answer, and the client is the one with the error table that can explain
   * it in the user's language.
   *
   * The response is never stored: it describes a simulation of one caller's
   * envelope against the current ledger, and a resource footprint is not a fact
   * that survives being cached.
   */
  app.post(
    '/transactions/prepare',
    {
      preHandler: [
        requireAuth,
        async (request: FastifyRequest) => {
          const check = await verifiedUserLimiter(request);
          if (!check.isAllowed && check.isExceeded) {
            const err = new Error('Rate limit exceeded, retry in 1 minute');
            (err as Error & { statusCode: number }).statusCode = 429;
            throw err;
          }
        },
      ],
      // Replaces the global budget for this route rather than adding to it.
      config: { rateLimit: PREPARE_RATE_LIMIT },
    },
    async (request, reply) => {
      const parsed = prepareBody.safeParse(request.body);
      if (!parsed.success) return invalidRequest(reply, parsed.error);

      // Called for its side effect of refusing an unauthenticated request before any
      // RPC work happens. Nothing else about the caller is needed: the envelope's
      // source is the account that will sign, and it is not this service's job to
      // decide whether that account may make the call — the contract does that.
      authenticatedUser(request);

      const outcome: PrepareOutcome = await prepareInvocation({
        envelopeXdr: parsed.data.transactionXdr,
        networkPassphrase,
        simulate,
        isAllowedContract,
        simulateTimeoutMs: options.simulateTimeoutMs,
      });

      reply.header('cache-control', 'no-store');

      if (outcome.status === 'invalid') {
        // A refusal here is about the envelope, not about the protocol, so the
        // reason is safe to name: it tells a client which of its own mistakes to fix
        // without revealing anything about this service's state.
        return reply.code(400).send({ error: outcome.reason });
      }

      if (outcome.status === 'upstream_failed') {
        return reply
          .code(outcome.reason === 'timeout' ? 503 : 502)
          .send({ error: 'upstream_unavailable' });
      }

      return reply.send({ data: outcome });
    },
  );
}
