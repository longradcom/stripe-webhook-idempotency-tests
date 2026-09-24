import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import type { Delivery } from "./contract";

/**
 * Events shaped the way Stripe sends them, signed the way Stripe signs them.
 *
 * `generateTestHeaderString` is the Stripe SDK's own signer, so a handler that
 * verifies with `stripe.webhooks.constructEvent` sees a genuine signature — the
 * suite does not ask you to switch verification off in tests.
 */

const stripe = new Stripe("sk_test_signing_only");

export interface TestEvent {
  id: string;
  type: string;
  invoiceId: string;
  /** The body as Stripe sends it: pretty-printed JSON, two-space indent. */
  rawBody: string;
}

export function invoicePaid(input: { customerId: string; invoiceId?: string; eventId?: string }): TestEvent {
  const invoiceId = input.invoiceId ?? `in_test_${short()}`;
  return build("invoice.paid", input.eventId, invoiceId, {
    id: invoiceId,
    object: "invoice",
    customer: input.customerId,
    amount_paid: 2000,
    currency: "usd",
    status: "paid",
  });
}

/** An event type a billing handler has no reason to act on. */
export function unhandled(input: { customerId: string }): TestEvent {
  const invoiceId = `in_test_${short()}`;
  return build("customer.tax_id.created", undefined, invoiceId, {
    id: `txi_test_${short()}`,
    object: "tax_id",
    customer: input.customerId,
  });
}

function build(type: string, eventId: string | undefined, invoiceId: string, object: object): TestEvent {
  const id = eventId ?? `evt_test_${short()}`;
  const body = {
    id,
    object: "event",
    api_version: "2026-08-26.dahlia",
    created: Math.floor(Date.now() / 1000),
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
  };
  return { id, type, invoiceId, rawBody: JSON.stringify(body, null, 2) };
}

/**
 * Sign a body. Every call produces a fresh timestamp and signature, which is
 * what a real Stripe retry looks like: same event id, new signature.
 */
export function sign(rawBody: string, secret: string): Delivery {
  return {
    rawBody,
    signature: stripe.webhooks.generateTestHeaderString({ payload: rawBody, secret }),
  };
}

function short() {
  return randomUUID().replaceAll("-", "").slice(0, 14);
}
