/**
 * Invite endpoints: create a code, and join by redeeming one.
 *
 * NEITHER OF THESE GRANTS ACCESS
 * The contract decides who may join a group and enforces the member capacity.
 * Creating an invite is therefore not an authorization decision — there is
 * nothing to authorize, because an invite carries no authority. What the code
 * buys is discoverability: it lets someone who was told about a group find it
 * without knowing its contract address. That is why the code must be unguessable
 * and why the table it lives in is readable by no browser role at all.
 *
 * This also means the "may this user invite?" question has no useful answer here.
 * The natural rule — only members may invite — cannot be checked, because the API
 * does not know which wallet a user controls unless they have linked one, and the
 * chain decides membership by address. Refusing when we cannot check would break
 * inviting for the majority of users and protect nothing, since the group and its
 * contract address are already public.
 *
 * JOIN CLAIMS A USE, IT DOES NOT JOIN
 * The blockchain is the only thing that can add a member, so redemption cannot be
 * the join. What `POST /invites/redeem` does is validate the code, claim one of its
 * uses, and report which group the code admits to, so the client can send the
 * transaction that actually joins. A use is claimed before that transaction
 * succeeds, which is the conservative direction: a failed transaction wastes a use
 * rather than letting a limited code admit more members than it should.
 *
 * WHY REDEMPTION HAS TWO SHAPES
 * An invite link carries a code and nothing else — that is what makes it opaque.
 * The code is unique and its row names the group, so `POST /invites/redeem` needs
 * only the code, and reports the group so a client that arrived from a link can go
 * on to send the join transaction. Requiring the contract address there would mean
 * a link could never satisfy the request.
 *
 * `POST /groups/:contractId/join` is the same claim for a caller that already
 * knows the group, plus the assertion that the code belongs to it. The path's
 * group is not what identifies anything; it is a consistency check on the client,
 * for the case where the code and the group came from different places.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticatedUser } from '../auth/guard';
import { generateInviteCode, isWellFormedInviteCode } from '../lib/invite-code';
import type { InviteStore } from '../db/invites';
import type { GroupStatus } from '../db/groups';
import { invalidRequest } from './errors';

/** A Soroban contract address. Matches the group routes' pattern. */
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

/** Default lifetime for an invite that does not specify one. */
export const DEFAULT_INVITE_TTL_HOURS = 24 * 7;

/** Longest lifetime the API will issue. Beyond this a leaked code is long-lived. */
export const MAX_INVITE_TTL_HOURS = 24 * 30;

export type InviteRoutesOptions = {
  store: InviteStore;
  /**
   * Answers whether this API recognises the address as a group.
   *
   * Deliberately not "does the indexer know this group". Between a creator's
   * confirmation and the indexer's next run — up to one scheduled interval — the
   * address is real and the index has never seen it, and a creator who has just
   * made a group is exactly the person about to invite someone to it. The check is
   * therefore the index *or* an unexpired registration; see `db/registrations.ts`.
   */
  isKnownGroup: (contractId: string) => Promise<boolean>;
  /**
   * The group's status as the read model last saw it, or `undefined` when the
   * index has not reached the contract yet.
   *
   * Used for one thing: declining to spend a use of a limited invite on a join
   * the chain would refuse. The answer is advisory and may be stale by one
   * indexer run, so it is only ever allowed to withhold a claim, never to
   * promise that a join will succeed.
   */
  groupStatus: (contractId: string) => Promise<GroupStatus | undefined>;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Injectable so tests can assert the expiry rather than race a clock. */
  now?: () => Date;
};

const params = z.object({
  contractId: z.string().regex(CONTRACT_ID_PATTERN, 'must be a Soroban contract address'),
});

const createBody = z.object({
  /**
   * Hours until the code stops working. Optional, with a default rather than no
   * expiry: the document requires expiring codes, and "never" is the one value
   * that cannot be walked back after a code leaks.
   */
  expiresInHours: z.coerce
    .number()
    .int()
    .min(1, 'must be at least 1 hour')
    .max(MAX_INVITE_TTL_HOURS, `must be at most ${MAX_INVITE_TTL_HOURS} hours`)
    .optional(),
  /** Omitted means limited only by the contract's own member capacity. */
  maxUses: z.coerce.number().int().min(1, 'must be a positive number of uses').max(1000).optional(),
});

const redeemBody = z.object({
  code: z.string().trim().min(1, 'must be an invite code'),
});

function groupNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'group_not_found' });
}

/**
 * A code that cannot be redeemed, reported as absent.
 *
 * Revoked, expired, wrong-group and unknown codes all get the same answer for the
 * same reason: any distinction confirms that a guessed code is real, which is
 * exactly what an unguessable code is protecting.
 */
function inviteNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'invite_not_found' });
}

export async function inviteRoutes(
  app: FastifyInstance,
  options: InviteRoutesOptions,
): Promise<void> {
  const { store, isKnownGroup, groupStatus, requireAuth } = options;
  const now = options.now ?? (() => new Date());

  const verifiedUserLimiter = app.createRateLimit({
    max: 20,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest): string => {
      const user = request.user;
      return user ? `user:${user.id}` : `ip:${request.ip}`;
    },
  });

  /**
   * Claims a use of `code` for the authenticated user.
   *
   * Shared by both join shapes. They differ only in the last step: the
   * group-scoped one also asserts that the code admits to the group in its path,
   * which turns a client bug — redeeming a code for a different group than the
   * one being displayed — into an error rather than a quiet join to somewhere
   * else.
   */
  async function claimUse(
    request: FastifyRequest,
    reply: FastifyReply,
    expectedGroup?: string,
  ): Promise<FastifyReply> {
    const parsedBody = redeemBody.safeParse(request.body);
    if (!parsedBody.success) return invalidRequest(reply, parsedBody.error);

    const { code } = parsedBody.data;
    // Refused on shape before any lookup. A stream of short or address-shaped
    // codes would otherwise be a stream of indexed queries.
    if (!isWellFormedInviteCode(code)) return inviteNotFound(reply);

    const user = authenticatedUser(request);
    const result = await store.redeem({
      code,
      userId: user.id,
      // A code shared before the group started keeps working after it has, and
      // the chain refuses a join unless the group is still open — so treating
      // "the group has moved on" as a reason to spend a use bills the visitor for
      // something that could never have worked.
      //
      // `undefined` means the index has not seen the group yet, which is the
      // normal state for a creator's brand-new group, so it claims. Only a status
      // that is positively known and not `open` withholds the claim.
      shouldClaim: async (groupContractId) => {
        const status = await groupStatus(groupContractId);
        return status === undefined || status === 'open';
      },
    });

    switch (result.outcome) {
      case 'redeemed':
        // The code names the group. A caller that supplied a different one asked
        // about the wrong group, which is answered the same way as an unknown
        // code: the code is not for that group, and saying so confirms nothing
        // about codes in general.
        if (expectedGroup !== undefined && result.groupContractId !== expectedGroup) {
          return inviteNotFound(reply);
        }

        // Either this is the first redemption or this user redeemed before; both
        // are success, which is what makes retrying a join safe.
        return reply.send({
          data: { groupContractId: result.groupContractId, inviteId: result.inviteId },
        });
      case 'exhausted':
        // Distinct from not_found because the caller did nothing wrong and a
        // fresh invite is a real remedy — and knowing the code was real tells
        // them nothing they did not already have.
        return reply.code(409).send({ error: 'invite_exhausted' });
      case 'revoked':
      case 'expired':
      case 'not_found':
        return inviteNotFound(reply);
    }
  }

  app.post(
    '/groups/:contractId/invites',
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
    },
    async (request, reply) => {
      const parsedParams = params.safeParse(request.params);
      if (!parsedParams.success) return invalidRequest(reply, parsedParams.error);

      const parsedBody = createBody.safeParse(request.body ?? {});
      if (!parsedBody.success) return invalidRequest(reply, parsedBody.error);

      const { contractId } = parsedParams.data;
      // Recognised means the index knows it, or the creator registered it after a
      // confirmation the indexer has not reached yet. Both answer the only question
      // this gate is asking: is this an address a code may name.
      if (!(await isKnownGroup(contractId))) return groupNotFound(reply);

      const user = authenticatedUser(request);
      const ttlHours = parsedBody.data.expiresInHours ?? DEFAULT_INVITE_TTL_HOURS;
      const expiresAt = new Date(now().getTime() + ttlHours * 60 * 60 * 1000);

      const invite = await store.create({
        code: generateInviteCode(),
        groupContractId: contractId,
        createdBy: user.id,
        expiresAt,
        maxUses: parsedBody.data.maxUses ?? null,
      });

      // The code is returned once, here, and cannot be read back afterwards: the
      // table has no policy granting a browser role anything, including to its
      // creator. That is what stops an invite from being enumerated after the fact.
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({
        data: {
          code: invite.code,
          groupContractId: invite.groupContractId,
          expiresAt: invite.expiresAt,
          maxUses: invite.maxUses,
          uses: invite.uses,
        },
      });
    },
  );

  /**
   * Redemption for a caller holding only the code.
   *
   * This is the shape an invite link needs: `/join/<code>` carries no address, so
   * this is also how the client learns which group the code admits to.
   */
  app.post('/invites/redeem', { preHandler: requireAuth }, async (request, reply) => {
    return claimUse(request, reply);
  });

  /**
   * Redemption for a caller that already knows the group.
   *
   * The same claim, plus the assertion that the code belongs to the group in the
   * path. A client that has a code and a group from different places can get that
   * wrong, and this is where the mismatch is caught.
   */
  app.post('/groups/:contractId/join', { preHandler: requireAuth }, async (request, reply) => {
    const parsedParams = params.safeParse(request.params);
    if (!parsedParams.success) return invalidRequest(reply, parsedParams.error);

    return claimUse(request, reply, parsedParams.data.contractId);
  });
}
