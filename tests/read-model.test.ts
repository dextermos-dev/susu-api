import { describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createGroupReadModel, toGroupStatus, toGroupSummary } from '../src/db/groups';
import type * as schema from '../src/db/schema';
import { GROUP_CONTRACT_ID } from './support/fixtures';

/**
 * The read model is the boundary where database values become API values, so
 * these tests are about what happens when the database returns something
 * unexpected — which is exactly the case a happy-path test cannot see.
 */

const dialect = new PgDialect();

function stubDb(rows: readonly unknown[]) {
  const execute = vi.fn(async (_statement: unknown) => ({ rows }));
  return {
    execute,
    db: { execute } as unknown as NodePgDatabase<typeof schema>,
  };
}

/**
 * A stub that answers each successive query differently.
 *
 * `getGroup` issues three statements and stops early when the first finds
 * nothing, so a stub that answers every call the same way cannot reach the
 * later ones.
 */
function stubDbSequence(results: readonly (readonly unknown[])[]) {
  let index = 0;
  const execute = vi.fn(async (_statement: unknown) => ({
    rows: results[index++] ?? [],
  }));
  return {
    execute,
    db: { execute } as unknown as NodePgDatabase<typeof schema>,
  };
}

/** The SQL and bound parameters a captured `execute` call would have sent. */
function renderedQuery(statement: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(statement as SQL);
  return { sql: query.sql, params: query.params };
}

/** The SQL a captured `execute` call would have sent. */
function rendered(statement: unknown): string {
  return renderedQuery(statement).sql;
}

type GroupRowInput = Parameters<typeof toGroupSummary>[0];

function groupRow(overrides: Record<string, unknown> = {}): GroupRowInput {
  return {
    contract_id: GROUP_CONTRACT_ID,
    factory_contract_id: `C${'E'.repeat(55)}`,
    group_id: '1',
    creator: `G${'C'.repeat(55)}`,
    token: `C${'F'.repeat(55)}`,
    contribution_amount: '100000000',
    member_capacity: '3',
    created_ledger: '4606483',
    status: 'active',
    member_count: '3',
    current_round: '1',
    completed_rounds: '0',
    contributed_total: '300000000',
    paid_out_total: '0',
    fee_total: '0',
    last_event_ledger: '4606500',
    // Cast through `unknown` so a test can deliberately violate the row's type,
    // which is how the guard's behaviour on bad input gets exercised.
    ...overrides,
  } as unknown as GroupRowInput;
}

describe('money is cast in SQL, not converted afterwards', () => {
  it('casts every monetary column to text in the group query', async () => {
    const { db, execute } = stubDb([]);
    await createGroupReadModel(db).getGroup(GROUP_CONTRACT_ID);

    const groupSql = rendered(execute.mock.calls[0]?.[0]);
    for (const column of [
      'contribution_amount',
      'contributed_total',
      'paid_out_total',
      'fee_total',
    ]) {
      expect(groupSql, column).toContain(`${column}::text`);
    }
  });

  it('casts amounts in each list query', async () => {
    const { db, execute } = stubDb([]);
    const model = createGroupReadModel(db);

    await model.listGroups({ limit: 1, offset: 0 });
    expect(rendered(execute.mock.calls[0]?.[0])).toContain('contribution_amount::text');

    await model.listContributions(GROUP_CONTRACT_ID, { limit: 1, offset: 0 });
    expect(rendered(execute.mock.calls[1]?.[0])).toContain('amount::text');

    await model.listPayouts(GROUP_CONTRACT_ID, { limit: 1, offset: 0 });
    expect(rendered(execute.mock.calls[2]?.[0])).toContain('recipient_amount::text');
  });

  it('sums the per-round pot in the database, not in JavaScript', async () => {
    // The total is never assembled from values that have been through a
    // JavaScript number: `sum()` stays a `numeric` and is cast on the way out.
    const { db, execute } = stubDbSequence([[groupRow()], [], []]);
    await createGroupReadModel(db).getGroup(GROUP_CONTRACT_ID);

    // The third statement `getGroup` issues is the per-round aggregate. The
    // SQL is collapsed first so the assertion does not depend on how the
    // formatter wrapped the query.
    const roundsSql = rendered(execute.mock.calls[2]?.[0]).replace(/\s+/g, ' ');
    expect(roundsSql).toContain('coalesce(sum(c.amount), 0)::text');
  });

  it('refuses an amount that arrived as a number instead of failing silently', async () => {
    // Simulates a lost `::text` cast, or a global type parser turning `numeric`
    // into a double. Returning the rounded value would be undetectable later.
    const { db } = stubDb([groupRow({ contributed_total: 300000000 })]);
    await expect(createGroupReadModel(db).getGroup(GROUP_CONTRACT_ID)).rejects.toThrow(
      /::text cast/,
    );
  });
});

describe('getGroup round aggregation', () => {
  it('aggregates per-round data using pre-grouped CTEs without correlated scalar subqueries', async () => {
    const { db, execute } = stubDbSequence([[groupRow()], [], []]);
    await createGroupReadModel(db).getGroup(GROUP_CONTRACT_ID);

    const roundsSql = rendered(execute.mock.calls[2]?.[0]).replace(/\s+/g, ' ');
    expect(roundsSql).toContain('with contrib_agg as');
    expect(roundsSql).toContain('payout_agg as');
    expect(roundsSql).toContain('fee_agg as');
    expect(roundsSql).toContain('left join contrib_agg');
    expect(roundsSql).not.toContain('where c.round = r.round');
    expect(roundsSql).not.toContain('where p.round = r.round');
    expect(roundsSql).not.toContain('where f.round = r.round');
  });

  it('runs against real postgres with no per-round correlated subplans and deterministic degradation', async () => {
    const pglite = new PGlite();
    await pglite.exec(`
      create table public.groups (
        contract_id text primary key,
        factory_contract_id text not null,
        group_id bigint not null,
        creator text not null,
        token text not null,
        contribution_amount numeric(39,0) not null,
        member_capacity integer not null,
        created_ledger bigint not null,
        status text not null default 'open',
        member_count integer not null default 0,
        current_round integer not null default 0,
        completed_rounds integer not null default 0,
        contributed_total numeric(39,0) not null default 0,
        paid_out_total numeric(39,0) not null default 0,
        fee_total numeric(39,0) not null default 0,
        last_event_ledger bigint not null default 0
      );
      create table public.group_members (
        contract_id text not null,
        member text not null,
        position integer not null,
        joined_ledger bigint not null
      );
      create table public.contributions (
        event_identity text primary key,
        contract_id text not null,
        member text not null,
        round integer not null,
        amount numeric(39,0) not null,
        ledger bigint not null,
        tx_hash text not null
      );
      create table public.payouts (
        event_identity text primary key,
        contract_id text not null,
        recipient text not null,
        round integer not null,
        recipient_amount numeric(39,0) not null,
        ledger bigint not null,
        tx_hash text not null
      );
      create table public.protocol_fees (
        event_identity text primary key,
        contract_id text not null,
        treasury text not null,
        round integer not null,
        fee numeric(39,0) not null,
        ledger bigint not null,
        tx_hash text not null
      );

      insert into public.groups values (
        '${GROUP_CONTRACT_ID}', 'CFACTORY', 1, 'GCREATOR', 'CTOKEN',
        100000000, 3, 100, 'active', 3, 2, 1, 300000000, 95000000, 5000000, 200
      );
      insert into public.group_members values
        ('${GROUP_CONTRACT_ID}', 'GMEMBER1', 1, 101),
        ('${GROUP_CONTRACT_ID}', 'GMEMBER2', 2, 102),
        ('${GROUP_CONTRACT_ID}', 'GMEMBER3', 3, 103);
      insert into public.contributions values
        ('e1', '${GROUP_CONTRACT_ID}', 'GMEMBER1', 1, 100000000, 110, 'h1'),
        ('e2', '${GROUP_CONTRACT_ID}', 'GMEMBER2', 1, 100000000, 111, 'h2'),
        ('e3', '${GROUP_CONTRACT_ID}', 'GMEMBER3', 1, 100000000, 112, 'h3'),
        ('e4', '${GROUP_CONTRACT_ID}', 'GMEMBER1', 2, 100000000, 120, 'h4');
      insert into public.payouts values
        ('p1', '${GROUP_CONTRACT_ID}', 'GMEMBER1', 1, 95000000, 115, 'hp1');
      insert into public.protocol_fees values
        ('f1', '${GROUP_CONTRACT_ID}', 'GTREASURY', 1, 5000000, 115, 'hf1');
    `);

    // Verify EXPLAIN has no SubPlan
    const explainResult = await pglite.query<{ 'QUERY PLAN': string }>(`
      explain with contrib_agg as (
        select
          c.round,
          count(*)::int as contribution_count,
          coalesce(sum(c.amount), 0)::text as contributed
        from public.contributions c
        where c.contract_id = '${GROUP_CONTRACT_ID}'
        group by c.round
      ),
      payout_agg as (
        select
          p.round,
          (array_agg(p.recipient_amount::text order by p.ledger desc, p.event_identity desc))[1] as payout,
          (array_agg(p.recipient order by p.ledger desc, p.event_identity desc))[1] as recipient
        from public.payouts p
        where p.contract_id = '${GROUP_CONTRACT_ID}'
        group by p.round
      ),
      fee_agg as (
        select
          f.round,
          (array_agg(f.fee::text order by f.ledger desc, f.event_identity desc))[1] as fee
        from public.protocol_fees f
        where f.contract_id = '${GROUP_CONTRACT_ID}'
        group by f.round
      ),
      rounds as (
        select round from contrib_agg
        union
        select round from payout_agg
      )
      select
        r.round,
        coalesce(c.contribution_count, 0)::int as contribution_count,
        coalesce(c.contributed, '0') as contributed,
        p.payout,
        p.recipient,
        f.fee
      from rounds r
      left join contrib_agg c on c.round = r.round
      left join payout_agg p on p.round = r.round
      left join fee_agg f on f.round = r.round
      order by r.round
    `);
    const planText = explainResult.rows.map((r) => Object.values(r)[0]).join('\\n');
    expect(planText).not.toContain('SubPlan');

    // Run through read model and check results
    const drizzleDb = drizzle(pglite) as unknown as NodePgDatabase<typeof schema>;
    const group = await createGroupReadModel(drizzleDb).getGroup(GROUP_CONTRACT_ID);
    expect(group).toBeDefined();
    expect(group?.rounds).toHaveLength(2);
    expect(group?.rounds[0]).toEqual({
      round: 1,
      contributionCount: 3,
      contributed: '300000000',
      payout: '95000000',
      recipient: 'GMEMBER1',
      fee: '5000000',
    });
    expect(group?.rounds[1]).toEqual({
      round: 2,
      contributionCount: 1,
      contributed: '100000000',
      payout: null,
      recipient: null,
      fee: null,
    });
    await pglite.close();
  });
});

describe('toGroupSummary', () => {
  it('maps a valid row, keeping money as strings', () => {
    const summary = toGroupSummary(groupRow());
    expect(summary.contractId).toBe(GROUP_CONTRACT_ID);
    expect(summary.groupId).toBe(1);
    expect(summary.contributedTotal).toBe('300000000');
    expect(summary.status).toBe('active');
  });

  it('preserves an amount that a double could not hold', () => {
    const maxI128 = '170141183460469231731687303715884105727';
    expect(toGroupSummary(groupRow({ contributed_total: maxI128 })).contributedTotal).toBe(maxI128);
  });

  it('rejects a status the contracts do not use', () => {
    expect(() => toGroupSummary(groupRow({ status: 'cancelled' }))).toThrow(/unrecognised value/);
  });

  it('rejects a ledger that is not a safe integer', () => {
    expect(() => toGroupSummary(groupRow({ created_ledger: '1e9' }))).toThrow(/safe integer/);
  });
});

describe('toGroupStatus', () => {
  it('accepts only the statuses the contracts emit', () => {
    expect(toGroupStatus('open')).toBe('open');
    expect(toGroupStatus('active')).toBe('active');
    expect(toGroupStatus('completed')).toBe('completed');
    expect(() => toGroupStatus('OPEN')).toThrow(/unrecognised value/);
  });
});

describe('pagination', () => {
  it('drops the extra row and reports that more exist', async () => {
    const rows = [1, 2, 3].map((round) => ({
      event_identity: `evt-${round}`,
      member: `G${'C'.repeat(55)}`,
      round,
      amount: '100000000',
      ledger: 4_606_500 + round,
      tx_hash: 'a'.repeat(64),
    }));

    const { db, execute } = stubDb(rows);
    const result = await createGroupReadModel(db).listContributions(GROUP_CONTRACT_ID, {
      limit: 2,
      offset: 0,
    });

    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    // `limit + 1` is requested precisely so the extra row can be dropped here.
    // Asserted on the bound parameter, not the SQL text: the placeholder index
    // is an artefact of parameter ordering and not what this test is about.
    const { params } = renderedQuery(execute.mock.calls[0]?.[0]);
    expect(params[1]).toBe(3);
  });

  it('reports no more rows when the page is not full', async () => {
    const { db } = stubDb([]);
    const result = await createGroupReadModel(db).listPayouts(GROUP_CONTRACT_ID, {
      limit: 20,
      offset: 0,
    });
    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });
});

describe('group existence', () => {
  it('is false when the group is not in the index', async () => {
    const { db } = stubDb([]);
    expect(await createGroupReadModel(db).groupExists(GROUP_CONTRACT_ID)).toBe(false);
  });

  it('is true when the group is present', async () => {
    const { db } = stubDb([{ present: 1 }]);
    expect(await createGroupReadModel(db).groupExists(GROUP_CONTRACT_ID)).toBe(true);
  });
});

describe('group status', () => {
  it('is undefined when the index has not seen the group', async () => {
    // Not the same as "not open". A group the indexer has not reached is the
    // normal state for a group its creator has just made, and the caller has to
    // be able to tell the two apart.
    const { db } = stubDb([]);
    expect(await createGroupReadModel(db).groupStatus(GROUP_CONTRACT_ID)).toBeUndefined();
  });

  it('reports the recorded status', async () => {
    const { db } = stubDb([{ status: 'active' }]);
    expect(await createGroupReadModel(db).groupStatus(GROUP_CONTRACT_ID)).toBe('active');
  });

  it('reads one column rather than assembling the whole group', async () => {
    const { db, execute } = stubDb([{ status: 'open' }]);
    await createGroupReadModel(db).groupStatus(GROUP_CONTRACT_ID);

    // One statement, and it does not touch members or rounds. This runs while a
    // visitor is waiting on a join, and `getGroup` would fetch all of it to
    // answer the same question.
    expect(execute).toHaveBeenCalledTimes(1);
    const { sql } = renderedQuery(execute.mock.calls[0]?.[0]);
    expect(sql).toContain('status');
    expect(sql).not.toContain('group_members');
  });

  it('refuses a status it does not recognise, instead of calling it closed', async () => {
    // A schema change has to be loud. Mapping an unknown value onto "not open"
    // would quietly refuse every join in the system, and look like a bug in
    // invites rather than a bug in the data.
    const { db } = stubDb([{ status: 'halted' }]);
    await expect(createGroupReadModel(db).groupStatus(GROUP_CONTRACT_ID)).rejects.toThrow(
      /unrecognised value/,
    );
  });
});

describe('the member activity feed', () => {
  const WALLET = `G${'D'.repeat(55)}`;

  it('scopes the feed by membership in SQL, not in JavaScript', async () => {
    const { db, execute } = stubDb([]);

    await createGroupReadModel(db).listMemberActivity(WALLET, { limit: 20, offset: 0 });

    const { sql, params } = renderedQuery(execute.mock.calls[0]?.[0]);
    // The address is a bound parameter of a membership test inside the query.
    // Filtering after the fact would mean reading other members' groups first,
    // and would leave the page size applying to rows the caller may not see.
    expect(sql).toContain('group_members');
    expect(sql).toContain('m.member =');
    expect(params).toContain(WALLET);
  });

  it('reads newest first, the opposite of a group audit trail', async () => {
    const { db, execute } = stubDb([]);

    await createGroupReadModel(db).listMemberActivity(WALLET, { limit: 20, offset: 0 });

    const sql = rendered(execute.mock.calls[0]?.[0]);
    expect(sql).toMatch(/order by e\.ledger desc/i);
  });

  it('carries the group each event came from', async () => {
    const { db } = stubDb([
      {
        contract_id: GROUP_CONTRACT_ID,
        event_identity: 'evt-1',
        name: 'payout_executed',
        ledger: 4_606_600,
        tx_index: 2,
        event_index: 0,
        tx_hash: 'b'.repeat(64),
        payload: { round: 2 },
      },
    ]);

    const result = await createGroupReadModel(db).listMemberActivity(WALLET, {
      limit: 20,
      offset: 0,
    });

    expect(result.items).toEqual([
      {
        contractId: GROUP_CONTRACT_ID,
        eventIdentity: 'evt-1',
        name: 'payout_executed',
        ledger: 4_606_600,
        txIndex: 2,
        eventIndex: 0,
        txHash: 'b'.repeat(64),
        payload: { round: 2 },
      },
    ]);
  });

  it('applies the page to a cross-group query too', async () => {
    const { db, execute } = stubDb([]);

    await createGroupReadModel(db).listMemberActivity(WALLET, { limit: 5, offset: 10 });

    const { params } = renderedQuery(execute.mock.calls[0]?.[0]);
    expect(params).toContain(6);
    expect(params).toContain(10);
  });
});
