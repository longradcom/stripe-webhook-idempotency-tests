import { PGlite } from "@electric-sql/pglite";

/**
 * An in-process Postgres (PGlite) so the examples run with `npm test` and
 * nothing to provision.
 *
 * The business effect is deliberately one that is wrong when repeated: a row
 * in a credits ledger. A handler that applies it twice gives a customer twice
 * what they paid for, which is the failure the suite counts.
 */
export async function createDb(options: { effectKeyedByInvoice: boolean }) {
  const db = await PGlite.create();
  await db.exec(`
    create table accounts (
      id text primary key,
      stripe_customer_id text unique not null
    );

    create table webhook_events (
      stripe_event_id text primary key,
      type text not null,
      status text not null,
      received_at timestamptz not null default now()
    );

    create table credit_entries (
      id bigint generated always as identity primary key,
      account_id text not null references accounts (id),
      invoice_id text not null,
      credits integer not null
    );
  `);
  if (options.effectKeyedByInvoice) {
    await db.exec(`create unique index credit_entries_invoice_idx on credit_entries (invoice_id);`);
  }
  return db;
}

export type Db = Awaited<ReturnType<typeof createDb>>;

export async function resetDb(db: Db, customerId: string) {
  await db.exec(`truncate credit_entries, webhook_events, accounts restart identity cascade;`);
  await db.query(`insert into accounts (id, stripe_customer_id) values ('acct_1', $1)`, [customerId]);
}

export async function creditEntries(db: Db, invoiceId: string) {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from credit_entries where invoice_id = $1`,
    [invoiceId],
  );
  return rows[0]!.n;
}
