import { sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { assertBaseUnits, assertCount } from '../lib/base-units';
import type { Page, PageResult } from '../lib/pagination';
import { paginate, queryRows as rawQueryRows } from './raw';
import type * as schema from './schema';

/**
 * Read model over the indexer's chain-derived tables.
 *
 * WHAT THIS READS
 * `groups`, `group_members`, `contributions`, `payouts`, `protocol_fees` and
 * `decoded_events`, all created and written by `susu-indexer`. This service never
 * writes them: the indexer is the only writer, and the chain is the only
 * authority. Nothing here decides an amount, a recipient, or eligibility — it
 * reports what the contracts did.
 *
 * WHY RAW SQL
 * These tables are not declared in `src/db/schema.ts` (see that file for why), so
 * the queries name their columns explicitly. That is not only a consequence of
 * the ownership boundary but the point of it: every monetary column is selected
 * with `::text`, which is the cast the indexer's migration says a reader must
 * make. A query builder would infer the column type from a schema this service
 * does not own, and the inference is exactly the thing that silently changes when
 * a `numeric` crosses into JavaScript.
 *
 * Read-only by construction: there is no insert, update or delete in this file,
 * and `scripts/run-db-security-tests.sh` fails CI if a browser role can write to
 * these tables from the exposed schema.
 */

export type GroupStatus = 'open' | 'active' | 'completed';

const GROUP_STATUSES: readonly GroupStatus[] = ['open', 'active', 'completed'];

export type GroupSummary = {
  readonly contractId: string;
  readonly factoryContractId: string;
  /** The factory's own sequential id, unique per factory. */
  readonly groupId: number;
  readonly creator: string;
  /** The SAC the group settles in, recorded rather than assumed to be USDC. */
  readonly token: string;
  /** Base units, as a string. Never a JSON number. */
  readonly contributionAmount: string;
  readonly memberCapacity: number;
  readonly createdLedger: number;
  readonly status: GroupStatus;
  readonly memberCount: number;
  readonly currentRound: number;
  readonly completedRounds: number;
  /** Base units, as a string. Never a JSON number. */
  readonly contributedTotal: string;
  readonly paidOutTotal: string;
  readonly feeTotal: string;
  /** Highest ledger any of the group's events came from; 0 if none derived yet. */
  readonly lastEventLedger: number;
};

export type GroupMember = {
  readonly member: string;
  /** 1-based join order, as the contract assigned it. */
  readonly position: number;
  readonly joinedLedger: number;
};

export type GroupRound = {
  readonly round: number;
  readonly contributionCount: number;
  /** Base units contributed this round, as a string. */
  readonly contributed: string;
  /** Base units paid out this round, or `null` if the round has not paid. */
  readonly payout: string | null;
  readonly recipient: string | null;
  readonly fee: string | null;
};

export type GroupDetail = GroupSummary & {
  readonly members: readonly GroupMember[];
  readonly rounds: readonly GroupRound[];
};

export type ContributionRecord = {
  readonly eventIdentity: string;
  readonly member: string;
  readonly round: number;
  /** Base units, as a string. */
  readonly amount: string;
  readonly ledger: number;
  readonly txHash: string;
};

export type PayoutRecord = {
  readonly eventIdentity: string;
  readonly recipient: string;
  readonly round: number;
  /** Base units, as a string. Net of the protocol fee. */
  readonly recipientAmount: string;
  readonly ledger: number;
  readonly txHash: string;
};

export type ActivityRecord = {
  readonly eventIdentity: string;
  readonly name: string;
  readonly ledger: number;
  readonly txIndex: number;
  readonly eventIndex: number;
  readonly txHash: string;
  /** The decoded event fields, exactly as the decoder produced them. */
  readonly payload: unknown;
};

/**
 * One event, with the group it belongs to.
 *
 * A member's feed spans groups, so a row that did not carry its contract id
 * could not be linked back to anything. The per-group activity list does not
 * need it — it was asked for one contract — which is why this is a separate
 * type rather than an extra field on `ActivityRecord`.
 */
export type MemberActivityRecord = ActivityRecord & {
  readonly contractId: string;
};

export type ListGroupsQuery = {
  readonly status?: GroupStatus;
  readonly creator?: string;
  /** Restricts to groups this address has joined. */
  readonly member?: string;
  readonly limit: number;
  readonly offset: number;
};

// Pagination types are shared with every other paginated resource; they are
// re-exported here so the read model's existing import sites do not change.
export type { Page, PageResult } from '../lib/pagination';

export type GroupReadModel = {
  listGroups(query: ListGroupsQuery): Promise<PageResult<GroupSummary>>;
  getGroup(contractId: string): Promise<GroupDetail | undefined>;
  groupExists(contractId: string): Promise<boolean>;
  /**
   * The group's status as the index last recorded it, or `undefined` when the
   * index has never seen the contract.
   *
   * Separate from `getGroup`, which answers the same question only after
   * gathering every member and every round. The callers that need this are asking
   * a single question with a single answer, and paying for the rest of the group
   * to ask it would be wasteful on a path a visitor is waiting on.
   *
   * `undefined` means "not known", which is not the same as "not open". A group
   * the indexer has not reached yet is exactly the case a creator hits, so the
   * distinction has to survive all the way to the caller.
   */
  groupStatus(contractId: string): Promise<GroupStatus | undefined>;
  listContributions(contractId: string, page: Page): Promise<PageResult<ContributionRecord>>;
  listPayouts(contractId: string, page: Page): Promise<PageResult<PayoutRecord>>;
  listActivity(contractId: string, page: Page): Promise<PageResult<ActivityRecord>>;
  /**
   * Every decoded event from every group this address has joined, newest first.
   *
   * This is the feed behind `/me/activity`. It is one query rather than one per
   * group, so a member of twenty groups does not make twenty requests, and it is
   * scoped by membership rather than by a parameter the caller supplies.
   */
  listMemberActivity(address: string, page: Page): Promise<PageResult<MemberActivityRecord>>;
};

// ---------------------------------------------------------------------------
// Row shapes, as selected. Snake_case mirrors the columns, because the SQL names
// them; the mappers below are the single place the two vocabularies meet.
// ---------------------------------------------------------------------------

type GroupRow = {
  contract_id: string;
  factory_contract_id: string;
  group_id: number | string;
  creator: string;
  token: string;
  contribution_amount: string;
  member_capacity: number | string;
  created_ledger: number | string;
  status: string;
  member_count: number | string;
  current_round: number | string;
  completed_rounds: number | string;
  contributed_total: string;
  paid_out_total: string;
  fee_total: string;
  last_event_ledger: number | string;
};

type GroupMemberRow = {
  member: string;
  position: number | string;
  joined_ledger: number | string;
};

type GroupRoundRow = {
  round: number | string;
  contribution_count: number | string;
  contributed: string;
  payout: string | null;
  recipient: string | null;
  fee: string | null;
};

type ContributionRow = {
  event_identity: string;
  member: string;
  round: number | string;
  amount: string;
  ledger: number | string;
  tx_hash: string;
};

type PayoutRow = {
  event_identity: string;
  recipient: string;
  round: number | string;
  recipient_amount: string;
  ledger: number | string;
  tx_hash: string;
};

type ActivityRow = {
  event_identity: string;
  name: string;
  ledger: number | string;
  tx_index: number | string;
  event_index: number | string;
  tx_hash: string;
  payload: unknown;
};

type MemberActivityRow = ActivityRow & {
  contract_id: string;
};

/**
 * Validates a stored status against the values the contracts use.
 *
 * Throws rather than passing an unrecognised value through: a status the API does
 * not know is a schema change somebody has to look at, and forwarding it would
 * push that discovery into every client.
 */
export function toGroupStatus(value: string): GroupStatus {
  const match = GROUP_STATUSES.find((status) => status === value);
  if (match === undefined) {
    throw new Error(`groups.status holds an unrecognised value: ${JSON.stringify(value)}`);
  }
  return match;
}

export function toGroupSummary(row: GroupRow): GroupSummary {
  return {
    contractId: row.contract_id,
    factoryContractId: row.factory_contract_id,
    groupId: assertCount(row.group_id, 'groups.group_id'),
    creator: row.creator,
    token: row.token,
    contributionAmount: assertBaseUnits(row.contribution_amount, 'groups.contribution_amount'),
    memberCapacity: assertCount(row.member_capacity, 'groups.member_capacity'),
    createdLedger: assertCount(row.created_ledger, 'groups.created_ledger'),
    status: toGroupStatus(row.status),
    memberCount: assertCount(row.member_count, 'groups.member_count'),
    currentRound: assertCount(row.current_round, 'groups.current_round'),
    completedRounds: assertCount(row.completed_rounds, 'groups.completed_rounds'),
    contributedTotal: assertBaseUnits(row.contributed_total, 'groups.contributed_total'),
    paidOutTotal: assertBaseUnits(row.paid_out_total, 'groups.paid_out_total'),
    feeTotal: assertBaseUnits(row.fee_total, 'groups.fee_total'),
    lastEventLedger: assertCount(row.last_event_ledger, 'groups.last_event_ledger'),
  };
}

function toGroupMember(row: GroupMemberRow): GroupMember {
  return {
    member: row.member,
    position: assertCount(row.position, 'group_members.position'),
    joinedLedger: assertCount(row.joined_ledger, 'group_members.joined_ledger'),
  };
}

function toGroupRound(row: GroupRoundRow): GroupRound {
  return {
    round: assertCount(row.round, 'round'),
    contributionCount: assertCount(row.contribution_count, 'round.contribution_count'),
    contributed: assertBaseUnits(row.contributed, 'round.contributed'),
    payout: row.payout === null ? null : assertBaseUnits(row.payout, 'round.payout'),
    recipient: row.recipient,
    fee: row.fee === null ? null : assertBaseUnits(row.fee, 'round.fee'),
  };
}

function toContribution(row: ContributionRow): ContributionRecord {
  return {
    eventIdentity: row.event_identity,
    member: row.member,
    round: assertCount(row.round, 'contributions.round'),
    amount: assertBaseUnits(row.amount, 'contributions.amount'),
    ledger: assertCount(row.ledger, 'contributions.ledger'),
    txHash: row.tx_hash,
  };
}

function toPayout(row: PayoutRow): PayoutRecord {
  return {
    eventIdentity: row.event_identity,
    recipient: row.recipient,
    round: assertCount(row.round, 'payouts.round'),
    recipientAmount: assertBaseUnits(row.recipient_amount, 'payouts.recipient_amount'),
    ledger: assertCount(row.ledger, 'payouts.ledger'),
    txHash: row.tx_hash,
  };
}

function toActivity(row: ActivityRow): ActivityRecord {
  return {
    eventIdentity: row.event_identity,
    name: row.name,
    ledger: assertCount(row.ledger, 'decoded_events.ledger'),
    txIndex: assertCount(row.tx_index, 'decoded_events.tx_index'),
    eventIndex: assertCount(row.event_index, 'decoded_events.event_index'),
    txHash: row.tx_hash,
    payload: row.payload,
  };
}

function toMemberActivity(row: MemberActivityRow): MemberActivityRecord {
  return { contractId: row.contract_id, ...toActivity(row) };
}

/** The columns every group query selects, so the shape cannot drift between them. */
const GROUP_COLUMNS = sql`
  contract_id,
  factory_contract_id,
  group_id,
  creator,
  token,
  contribution_amount::text as contribution_amount,
  member_capacity,
  created_ledger,
  status,
  member_count,
  current_round,
  completed_rounds,
  contributed_total::text as contributed_total,
  paid_out_total::text as paid_out_total,
  fee_total::text as fee_total,
  last_event_ledger
`;

export function createGroupReadModel(db: NodePgDatabase<typeof schema>): GroupReadModel {
  async function queryRows(statement: SQL): Promise<readonly unknown[]> {
    return rawQueryRows(db, statement);
  }

  return {
    async listGroups(query) {
      const conditions: SQL[] = [];
      if (query.status !== undefined) {
        conditions.push(sql`status = ${query.status}`);
      }
      if (query.creator !== undefined) {
        conditions.push(sql`creator = ${query.creator}`);
      }
      if (query.member !== undefined) {
        conditions.push(sql`exists (
          select 1 from public.group_members m
          where m.contract_id = public.groups.contract_id and m.member = ${query.member}
        )`);
      }

      const where =
        conditions.length === 0 ? sql`` : sql`where ${sql.join(conditions, sql` and `)}`;

      const rows = await queryRows(sql`
        select ${GROUP_COLUMNS}
        from public.groups
        ${where}
        order by created_ledger desc, contract_id
        limit ${query.limit + 1} offset ${query.offset}
      `);

      return paginate((rows as GroupRow[]).map(toGroupSummary), query.limit);
    },

    async getGroup(contractId) {
      const groupRows = await queryRows(sql`
        select ${GROUP_COLUMNS}
        from public.groups
        where contract_id = ${contractId}
      `);

      const group = (groupRows as GroupRow[])[0];
      if (group === undefined) return undefined;

      const memberRows = await queryRows(sql`
        select member, position, joined_ledger
        from public.group_members
        where contract_id = ${contractId}
        order by position
      `);

      // Aggregated in SQL rather than by folding the contribution list in
      // JavaScript: the sum stays a `numeric` in the database, so no total is
      // ever assembled from values that have already been through a JS number.
      const roundRows = await queryRows(sql`
        with rounds as (
          select round from public.contributions where contract_id = ${contractId}
          union
          select round from public.payouts where contract_id = ${contractId}
        )
        select
          r.round,
          (select count(*)::int from public.contributions c
            where c.contract_id = ${contractId} and c.round = r.round) as contribution_count,
          (select coalesce(sum(c.amount), 0)::text from public.contributions c
            where c.contract_id = ${contractId} and c.round = r.round) as contributed,
          (select (array_agg(p.recipient_amount::text order by p.ledger desc, p.event_identity desc))[1]
            from public.payouts p
            where p.contract_id = ${contractId} and p.round = r.round) as payout,
          (select (array_agg(p.recipient order by p.ledger desc, p.event_identity desc))[1]
            from public.payouts p
            where p.contract_id = ${contractId} and p.round = r.round) as recipient,
          (select (array_agg(f.fee::text order by f.ledger desc, f.event_identity desc))[1]
            from public.protocol_fees f
            where f.contract_id = ${contractId} and f.round = r.round) as fee
        from rounds r
        order by r.round
      `);

      return {
        ...toGroupSummary(group),
        members: (memberRows as GroupMemberRow[]).map(toGroupMember),
        rounds: (roundRows as GroupRoundRow[]).map(toGroupRound),
      };
    },

    async groupExists(contractId) {
      const rows = await queryRows(sql`
        select 1 as present from public.groups where contract_id = ${contractId}
      `);
      return rows.length > 0;
    },

    async groupStatus(contractId) {
      const rows = await queryRows(sql`
        select status from public.groups where contract_id = ${contractId}
      `);
      const row = (rows as { status: string }[])[0];
      // Throws on a value it does not recognise, via `toGroupStatus`, rather than
      // reporting "not open" for a schema change. A caller that cannot tell a
      // broken status from a closed group would refuse joins for the wrong reason.
      return row === undefined ? undefined : toGroupStatus(row.status);
    },

    async listContributions(contractId, page) {
      const rows = await queryRows(sql`
        select
          event_identity,
          member,
          round,
          amount::text as amount,
          ledger,
          tx_hash
        from public.contributions
        where contract_id = ${contractId}
        order by round, ledger, event_identity
        limit ${page.limit + 1} offset ${page.offset}
      `);

      return paginate((rows as ContributionRow[]).map(toContribution), page.limit);
    },

    async listPayouts(contractId, page) {
      const rows = await queryRows(sql`
        select
          event_identity,
          recipient,
          round,
          recipient_amount::text as recipient_amount,
          ledger,
          tx_hash
        from public.payouts
        where contract_id = ${contractId}
        order by round, ledger, event_identity
        limit ${page.limit + 1} offset ${page.offset}
      `);

      return paginate((rows as PayoutRow[]).map(toPayout), page.limit);
    },

    async listActivity(contractId, page) {
      const rows = await queryRows(sql`
        select
          event_identity,
          name,
          ledger,
          tx_index,
          event_index,
          tx_hash,
          payload
        from public.decoded_events
        where contract_id = ${contractId}
        order by ledger, tx_index, event_index
        limit ${page.limit + 1} offset ${page.offset}
      `);

      return paginate((rows as ActivityRow[]).map(toActivity), page.limit);
    },

    /**
     * The signed-in member's feed: activity from every group they are in.
     *
     * ORDER IS THE OPPOSITE OF THE AUDIT TRAIL, deliberately. A group's own
     * activity list is read oldest-first because it is a record of how the group
     * got where it is. A feed is read newest-first, because the question it
     * answers is "what just happened" rather than "how did we get here".
     *
     * Scoping is by membership, matched in SQL against the address the caller's
     * session is bound to — never against a parameter. An address that is in no
     * group returns an empty page rather than an error: having no wallet linked
     * and being in no group are the same answer to this question.
     *
     * The membership test is a semi-join, which the indexer's
     * `group_members_member_idx` supports; the events then come from
     * `decoded_events_contract_ledger_idx`. `order by` across several contracts
     * is a sort, and that is the cost of a cross-group feed over a per-group
     * index — the alternative is a denormalised feed table, which would be a
     * second copy of chain data to keep honest.
     */
    async listMemberActivity(address, page) {
      const rows = await queryRows(sql`
        select
          e.contract_id,
          e.event_identity,
          e.name,
          e.ledger,
          e.tx_index,
          e.event_index,
          e.tx_hash,
          e.payload
        from public.decoded_events e
        where e.contract_id in (
          select m.contract_id from public.group_members m where m.member = ${address}
        )
        order by e.ledger desc, e.tx_index desc, e.event_index desc
        limit ${page.limit + 1} offset ${page.offset}
      `);

      return paginate((rows as MemberActivityRow[]).map(toMemberActivity), page.limit);
    },
  };
}
