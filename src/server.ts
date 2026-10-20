import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { getEnv } from './lib/env';
import { buildLoggerOptions } from './lib/logger';
import { createGroupReadModel, type GroupReadModel } from './db/groups';
import { createAccountReadModel, type AccountReadModel } from './db/me';
import { createWalletLinkStore, type WalletLinkStore } from './db/wallet';
import { createInviteStore, type InviteStore } from './db/invites';
import { createRegistrationStore, type RegistrationStore } from './db/registrations';
import { createNotificationReadModel, type NotificationReadModel } from './db/notifications';
import { createTransactionReadModel, type TransactionReadModel } from './db/transactions';
import { createNonceIssuer, type NonceIssuer } from './lib/nonce';
import { createSorobanSimulator, type SorobanSimulator } from './lib/soroban';
import { getDb } from './db/client';
import { createRequireAuth } from './auth/guard';
import { createTokenVerifier, type TokenVerifier } from './auth/verify';
import {
  createAccountDeleter,
  createSupabaseAdminClient,
  type AccountDeleter,
} from './supabase/admin';
import { healthRoutes } from './routes/health';
import { groupRoutes } from './routes/groups';
import { inviteRoutes } from './routes/invites';
import { meRoutes } from './routes/me';
import { notificationRoutes } from './routes/notifications';
import { transactionRoutes } from './routes/transactions';
import { walletRoutes } from './routes/wallet';

/**
 * Dependencies a caller may substitute.
 *
 * All are injectable so tests can exercise the routes — including the failure
 * paths, which are the ones worth testing — without a database or a Supabase
 * project. Production passes none of them and gets the real implementations.
 */
export type BuildServerOptions = {
  readModel?: GroupReadModel;
  probeDatabase?: () => Promise<void>;
  accountReadModel?: AccountReadModel;
  verifyToken?: TokenVerifier;
  deleteAccount?: AccountDeleter;
  walletLinkStore?: WalletLinkStore;
  nonceIssuer?: NonceIssuer;
  inviteStore?: InviteStore;
  registrations?: RegistrationStore;
  notificationReadModel?: NotificationReadModel;
  transactionReadModel?: TransactionReadModel;
  sorobanSimulator?: SorobanSimulator;
  trustProxy?: FastifyServerOptions['trustProxy'];
  rateLimitMax?: number;
  enableNonceReaping?: boolean;
  reapNonces?: boolean;
};

/**
 * Resolves trustProxy setting from environment CIDRs or explicit option override.
 *
 * Trusting all proxies (`true`) allows any client to spoof `X-Forwarded-*` headers,
 * bypassing IP-keyed rate limits and audit logs. By default, proxies are untrusted
 * (`false`) unless specific trusted CIDRs or options are configured.
 */
export function resolveTrustProxy(
  configuredCidrs?: string,
  optionOverride?: FastifyServerOptions['trustProxy'],
): FastifyServerOptions['trustProxy'] {
  if (optionOverride !== undefined) {
    return optionOverride;
  }
  if (!configuredCidrs) {
    return false;
  }
  const cidrs = configuredCidrs
    .split(',')
    .map((cidr) => cidr.trim())
    .filter((cidr) => cidr.length > 0);
  return cidrs.length > 0 ? cidrs : false;
}

/**
 * Builds the API server.
 *
 * SECURITY POSTURE
 * - Strict CORS allowlist: an empty allowlist means no cross-origin access.
 * - Secure headers via helmet.
 * - Rate limiting enabled globally.
 * - Small request body limit.
 * - Secret-free structured logging with redaction.
 *
 * This service is an application layer only. It never holds custody and never
 * decides balances, payout recipients, eligibility, or financial authorization.
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const env = getEnv();
  const trustProxy = resolveTrustProxy(env.TRUSTED_PROXY_CIDRS, options.trustProxy);

  const app = Fastify({
    logger: buildLoggerOptions(env.NODE_ENV),
    bodyLimit: 64 * 1024,
    trustProxy,
  });

  await app.register(helmet, {
    // This service returns JSON only; CSP is applied by the web app host.
    contentSecurityPolicy: false,
  });

  const allowedOrigins = env.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  await app.register(cors, {
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: options.rateLimitMax ?? 100,
    timeWindow: '1 minute',
  });

  await app.register(healthRoutes, { probeDatabase: options.probeDatabase });

  // One Supabase client, shared by token verification and account deletion.
  // Constructing it opens no connection, so this costs nothing on routes that
  // never touch Supabase.
  const supabase = createSupabaseAdminClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const verifyToken = options.verifyToken ?? createTokenVerifier(supabase);
  const deleteAccount =
    options.deleteAccount ??
    createAccountDeleter(supabase, {
      // A profile photo that outlived its account is untidy, not exposed — the
      // only policy that could read it belonged to the deleted user — but it is
      // still something an operator should be able to see in the logs rather
      // than discover on a storage bill.
      onWarning: (message) => app.log.warn({ event: 'account_cleanup' }, message),
    });

  // Versioned application surface. `getDb()` builds a connection pool lazily, so
  // constructing the read model opens no connection until the first query. One
  // instance is shared by the public group routes, by the invite routes — which
  // need it to tell "this group has nothing yet" from "there is no such group" —
  // and by the account surface, whose activity feed is a question about groups.
  const groupReadModel = options.readModel ?? createGroupReadModel(getDb());

  // Account routes are the authenticated surface: each declares `requireAuth`,
  // and identity comes from the verified token rather than from the request.
  await app.register(meRoutes, {
    prefix: '/api/v1',
    accountReadModel: options.accountReadModel ?? createAccountReadModel(getDb()),
    requireAuth: createRequireAuth(verifyToken),
    deleteAccount,
    // The feed is scoped by the caller's linked wallet, which the route reads
    // from the account model. Nothing about the address comes from the request.
    listMemberActivity: (address, page) => groupReadModel.listMemberActivity(address, page),
  });

  // Wallet linking is a two-step authenticated handshake. The nonce issuer holds
  // the signing secret and the message shape; the store owns the two facts the
  // database enforces — that a nonce is spent once, and that an address belongs
  // to one account.
  const walletLinkStore = options.walletLinkStore ?? createWalletLinkStore(getDb());

  await app.register(walletRoutes, {
    prefix: '/api/v1',
    requireAuth: createRequireAuth(verifyToken),
    store: walletLinkStore,
    nonces:
      options.nonceIssuer ??
      createNonceIssuer({
        secret: env.WALLET_NONCE_SECRET,
        networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
      }),
  });

  // The registrations a creator makes when the indexer has not yet seen their
  // group. Shared by the route that records them and the invite gate that honours
  // them, so the two cannot disagree about what "known" means.
  const registrations = options.registrations ?? createRegistrationStore(getDb());

  /**
   * Whether an address may be treated as a group.
   *
   * The index is the authority, but it trails the chain by up to one indexing run,
   * and the creator is the person most likely to need the API to recognise a group
   * in exactly that window. An unexpired registration is the same answer for a
   * bounded while; see `db/registrations.ts` for why a claim is acceptable here.
   */
  const isKnownGroup = async (contractId: string): Promise<boolean> => {
    if (await groupReadModel.groupExists(contractId)) return true;
    return registrations.isRegistered(contractId);
  };

  /**
   * The group's status, or `undefined` when the index has not seen it.
   *
   * Deliberately not folded into `isKnownGroup`: "we know this group exists" and
   * "we know what state it is in" are different answers, and a caller that needs
   * the second must be able to tell it apart from not knowing at all.
   */
  const groupStatus = async (contractId: string) => groupReadModel.groupStatus(contractId);

  const requireAuth = createRequireAuth(verifyToken);

  await app.register(groupRoutes, {
    prefix: '/api/v1',
    readModel: groupReadModel,
    requireAuth,
    registrations,
  });

  await app.register(inviteRoutes, {
    prefix: '/api/v1',
    requireAuth,
    store: options.inviteStore ?? createInviteStore(getDb()),
    isKnownGroup,
    groupStatus,
  });

  // Notifications are user-owned and injected as a model, like the account routes
  // above: the API connects as the database owner, so RLS does not apply to these
  // queries and each statement scopes to the caller itself.
  await app.register(notificationRoutes, {
    prefix: '/api/v1',
    requireAuth: createRequireAuth(verifyToken),
    readModel: options.notificationReadModel ?? createNotificationReadModel(getDb()),
  });

  // Public reads, plus the one authenticated preparation route: a transaction's
  // events are on the ledger already, but simulating an envelope spends this
  // service's RPC quota, so that one requires a session.
  await app.register(transactionRoutes, {
    prefix: '/api/v1',
    requireAuth,
    readModel: options.transactionReadModel ?? createTransactionReadModel(getDb()),
    simulate: options.sorobanSimulator ?? createSorobanSimulator(env.STELLAR_RPC_URL),
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
    // The Factory, or a group the index has actually seen. Registrations are
    // deliberately not honoured here: they are unverified claims, and letting
    // them through would turn prepare into an open simulation proxy for anyone
    // with a session. They stay scoped to invite creation only.
    isAllowedContract: async (contractId) =>
      (env.FACTORY_CONTRACT_ID !== '' && contractId === env.FACTORY_CONTRACT_ID) ||
      (await groupReadModel.groupExists(contractId)),
  });

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send({ error: 'not_found' });
  });
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'request failed');

    // Never surface internal error details to clients.
    const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    await reply.code(statusCode).send({
      error: statusCode === 500 ? 'internal_error' : error.code || 'request_error',
    });
  });

  // Started only when explicitly enabled (such as production startup in index.ts)
  // or in tests that explicitly opt in. Cleared cleanly on server shutdown.
  const shouldReap = options.enableNonceReaping ?? options.reapNonces ?? false;
  if (shouldReap) {
    const timer = startNonceReaping(walletLinkStore, app.log);
    app.addHook('onClose', async () => {
      clearInterval(timer);
    });
  }

  return app;
}

/** How often spent nonces are cleared. Well inside the five-minute nonce lifetime. */
const REAP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Clears spent nonces whose expiry has passed, on a timer.
 *
 * A nonce row is deliberately kept past its expiry rather than deleted on the way
 * out, so that a replayed nonce is refused as a replay rather than as an unknown
 * token. That means something has to remove them, and nothing did: the store's
 * `reap` was written, tested and never called, so `wallet_link_nonces` grew by a
 * row for every abandoned link attempt with no bound on it.
 *
 * This runs in the process rather than as a database schedule because it is
 * housekeeping, not a pipeline: it is allowed to wait for this service to be
 * running, and an instance that restarts simply reaps sooner. Two instances
 * reaping at once is harmless — the loser deletes nothing.
 *
 * A failure is logged and retried on the next tick. An untidy table is not a
 * reason to take the service down.
 */
export function startNonceReaping(
  store: Pick<WalletLinkStore, 'reap'>,
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>,
  intervalMs: number = REAP_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    store
      .reap(new Date())
      .then((count) => {
        if (count > 0) {
          log.info({ event: 'nonce_reap', count }, 'cleared expired wallet-link nonces');
        }
      })
      .catch((error: unknown) => {
        log.warn({ event: 'nonce_reap_failed', err: error }, 'could not clear expired nonces');
      });
  }, intervalMs);

  // Housekeeping must never be the reason the process stays alive.
  timer.unref();

  return timer;
}
