import Stripe from "stripe";
import type { Db } from "./db";
import type { Faults } from "./faults";

/**
 * Three webhook handlers with the same shape as a Next.js route handler:
 * `(request: Request) => Promise<Response>`.
 *
 * One is correct. The other two are the implementations a capable engineer —
 * or a coding agent — most often writes, and each passes a casual review. The
 * suite catches both; `tests/catches-known-bugs.test.ts` proves exactly which
 * property catches which.
 */

export interface HandlerDeps {
  db: Db;
  webhookSecret: string;
  faults: Faults;
}

export type Handler = (request: Request) => Promise<Response>;

const stripe = new Stripe("sk_test_verification_only");

const CREDITS_PER_INVOICE = 100;

/** Verify against the raw body. Returns null on any signature failure. */
async function verify(request: Request, secret: string): Promise<{ event: Stripe.Event } | null> {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";
  try {
    return { event: stripe.webhooks.constructEvent(rawBody, signature, secret) };
  } catch {
    return null;
  }
}

const ok = () => new Response(null, { status: 200 });
const badSignature = () => new Response("invalid signature", { status: 400 });
const failed = () => new Response("processing failed", { status: 500 });

type Tx = Pick<Db, "query">;

async function accountFor(tx: Tx, invoice: Stripe.Invoice): Promise<string> {
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
  const { rows } = await tx.query<{ id: string }>(`select id from accounts where stripe_customer_id = $1`, [
    customerId,
  ]);
  if (!rows[0]) throw new Error(`no account for customer ${customerId}`);
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Correct
// ---------------------------------------------------------------------------

/**
 * Receipt and effect in one transaction, and the effect keyed by invoice.
 *
 * - The claim (`insert ... on conflict do nothing`) and the credit entry commit
 *   together, so "we have seen this event" and "its effect exists" are the
 *   same fact. If anything fails, both roll back and Stripe's retry finds a
 *   clean slate.
 * - Under real Postgres a concurrent copy blocks on the unique key until the
 *   first commits, then finds the row and stops. No in-process lock involved.
 * - The credit entry is unique per invoice, so two different events about the
 *   same payment still grant once.
 *
 * This is the simplest correct shape, for a handler whose whole effect is local
 * database writes. A handler that calls Stripe or other services needs a
 * durable job instead of doing the work inside the request.
 */
export function transactionalHandler({ db, webhookSecret, faults }: HandlerDeps): Handler {
  return async (request) => {
    const verified = await verify(request, webhookSecret);
    if (!verified) return badSignature();
    const { event } = verified;
    if (event.type !== "invoice.paid") return ok();

    try {
      await db.transaction(async (tx) => {
        const claimed = await tx.query(
          `insert into webhook_events (stripe_event_id, type, status) values ($1, $2, 'processed')
           on conflict (stripe_event_id) do nothing
           returning stripe_event_id`,
          [event.id, event.type],
        );
        // Already committed by an earlier delivery — together with its effect.
        if (claimed.rows.length === 0) return;

        faults.hit("after-receipt");

        const invoice = event.data.object as Stripe.Invoice;
        await tx.query(
          `insert into credit_entries (account_id, invoice_id, credits) values ($1, $2, $3)
           on conflict (invoice_id) do nothing`,
          [await accountFor(tx, invoice), invoice.id, CREDITS_PER_INVOICE],
        );

        faults.hit("after-effect");
      });
      return ok();
    } catch {
      return failed();
    }
  };
}

// ---------------------------------------------------------------------------
// Bug 1: seen is processed
// ---------------------------------------------------------------------------

/**
 * The most common implementation, and the one the blog post is about.
 *
 * Record the event id; if it was already there, acknowledge and stop. Trace a
 * database timeout between the insert and the credit: the endpoint correctly
 * answers 500, Stripe retries, the insert conflicts, the handler concludes
 * "duplicate" and answers 200. Stripe stops retrying. Nobody ever applied the
 * event, and nothing anywhere reports an error.
 */
export function seenIsProcessedHandler({ db, webhookSecret, faults }: HandlerDeps): Handler {
  return async (request) => {
    const verified = await verify(request, webhookSecret);
    if (!verified) return badSignature();
    const { event } = verified;
    if (event.type !== "invoice.paid") return ok();

    try {
      const inserted = await db.query(
        `insert into webhook_events (stripe_event_id, type, status) values ($1, $2, 'received')
         on conflict (stripe_event_id) do nothing
         returning stripe_event_id`,
        [event.id, event.type],
      );
      if (inserted.rows.length === 0) return ok(); // "duplicate"

      faults.hit("after-receipt");

      const invoice = event.data.object as Stripe.Invoice;
      await db.query(`insert into credit_entries (account_id, invoice_id, credits) values ($1, $2, $3)`, [
        await accountFor(db, invoice),
        invoice.id,
        CREDITS_PER_INVOICE,
      ]);

      faults.hit("after-effect");
      return ok();
    } catch {
      return failed();
    }
  };
}

// ---------------------------------------------------------------------------
// Bug 2: check, then act
// ---------------------------------------------------------------------------

/**
 * The usual fix for bug 1, and a new bug.
 *
 * Track a status, and skip only events already marked processed. Retries now
 * work — but "is it processed?" and "mark it processed" are separate
 * statements with the effect between them. Two simultaneous copies both see
 * "not processed" and both credit. A crash after the credit and before the
 * mark leaves an event that is credited and not marked, so the retry credits
 * again.
 */
export function checkThenActHandler({ db, webhookSecret, faults }: HandlerDeps): Handler {
  return async (request) => {
    const verified = await verify(request, webhookSecret);
    if (!verified) return badSignature();
    const { event } = verified;
    if (event.type !== "invoice.paid") return ok();

    try {
      const { rows } = await db.query<{ status: string }>(
        `select status from webhook_events where stripe_event_id = $1`,
        [event.id],
      );
      if (rows[0]?.status === "processed") return ok();

      await db.query(
        `insert into webhook_events (stripe_event_id, type, status) values ($1, $2, 'processing')
         on conflict (stripe_event_id) do update set status = 'processing'`,
        [event.id, event.type],
      );

      faults.hit("after-receipt");

      const invoice = event.data.object as Stripe.Invoice;
      await db.query(`insert into credit_entries (account_id, invoice_id, credits) values ($1, $2, $3)`, [
        await accountFor(db, invoice),
        invoice.id,
        CREDITS_PER_INVOICE,
      ]);

      faults.hit("after-effect");

      await db.query(`update webhook_events set status = 'processed' where stripe_event_id = $1`, [event.id]);
      return ok();
    } catch {
      return failed();
    }
  };
}
