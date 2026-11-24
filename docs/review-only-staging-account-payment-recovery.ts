// REVIEW ONLY: staging-only server-side Stripe TEST survey-credit verification.
// Not deployed. Requires the separately reviewed staging credit approval table
// from draft PR #10 before this function can run successfully.
// Never deploy this function to production or use live Stripe keys.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.10";

const STAGING_URL = "https://hexhtduvqzleoazusskh.supabase.co";
const ALLOWED_ORIGIN = "https://urbanfold.github.io";
const ID = /^cs_test_[A-Za-z0-9]+$/;
const INTENT = /^pi_[A-Za-z0-9]+$/;
const CHARGE = /^ch_[A-Za-z0-9]+$/;

function respond(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": ALLOWED_ORIGIN,
      "access-control-allow-headers": "authorization,apikey,content-type,x-client-info",
      "access-control-allow-methods": "POST,OPTIONS",
      "vary": "Origin",
    },
  });
}

async function stripeGet(path: string, secret: string): Promise<Record<string, unknown>> {
  const response = await fetch("https://api.stripe.com/v1/" + path, {
    headers: { authorization: "Bearer " + secret },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Stripe test lookup unavailable");
  return await response.json();
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function idOf(value: unknown): string {
  return typeof value === "string" ? value : String(object(value).id ?? "");
}

Deno.serve(async (request: Request) => {
  if (Deno.env.get("SUPABASE_URL") !== STAGING_URL) {
    return respond({ error: "This function is restricted to Urbanfold staging." }, 503);
  }
  if (request.headers.get("origin") !== ALLOWED_ORIGIN) return respond({ error: "Origin rejected." }, 403);
  if (request.method === "OPTIONS") return respond({});
  if (request.method !== "POST") return respond({ error: "POST required." }, 405);

  const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") || "")?.[1];
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!bearer || !anonKey) return respond({ error: "Sign in required." }, 401);

  const auth = createClient(STAGING_URL, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: authError } = await auth.auth.getUser(bearer);
  if (authError || !user || !user.email || !user.email_confirmed_at) {
    return respond({ error: "Confirmed staging account required." }, 403);
  }

  let body: Record<string, unknown>;
  try { body = object(await request.json()); } catch {
    return respond({ error: "Invalid request." }, 400);
  }
  const reference = body.checkout_session_id;
  if (reference !== undefined && (typeof reference !== "string" || reference.length > 255 || !ID.test(reference))) {
    return respond({ error: "Only Stripe test Checkout Sessions are allowed." }, 400);
  }
  const secret = Deno.env.get("STAGING_STRIPE_TEST_SECRET_KEY") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!/^(?:sk_test_|rk_test_)[A-Za-z0-9]+$/.test(secret) || !serviceKey) {
    return respond({ error: "Staging payment confirmation unavailable." }, 503);
  }

  try {
    const db = createClient(STAGING_URL, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Use the authenticated owner, never a browser-supplied user ID.
    let query = db.from("staging_survey_checkout_attempts")
      .select("checkout_session_id,user_id").eq("user_id", user.id)
      .order("created_at", { ascending: false }).limit(6);
    if (typeof reference === "string") query = query.eq("checkout_session_id", reference);
    const { data: tracked, error: trackingError } = await query;
    if (trackingError || !Array.isArray(tracked) || tracked.length > 6 ||
        tracked.some(row => row.user_id !== user.id || typeof row.checkout_session_id !== "string" ||
          !ID.test(row.checkout_session_id) || (reference !== undefined && row.checkout_session_id !== reference))) {
      return respond({ error: "Checkout recovery unavailable." }, 503);
    }
    if (reference !== undefined && tracked.length !== 1)
      return respond({ error: "Checkout reference unavailable for this account." }, 404);
    let approved = 0, pending = 0, ineligible = 0;
    for (const row of tracked.slice(0, 5)) {
    const sessionId = row.checkout_session_id;
    const session = await stripeGet("checkout/sessions/" + encodeURIComponent(sessionId), secret);
    const metadata = object(session.metadata);
    const email = user.email.toLowerCase();
    // Explicit checkout purpose prevents older dedicated-buyer or synthetic
    // test sessions from being approved for the normal staging survey.
    const owned = session.id === sessionId && session.livemode === false &&
      session.client_reference_id === user.id &&
      typeof session.customer_email === "string" &&
      session.customer_email.toLowerCase() === email &&
      metadata.urbanfold_environment === "STAGING_ONLY" &&
      metadata.urbanfold_buyer_uid === user.id &&
      metadata.urbanfold_checkout_purpose === "staging_survey_extra_credit";
    if (!owned) return respond({ verified: false, error: "Checkout buyer or purpose mismatch." }, 403);

    const intentId = idOf(session.payment_intent);
    if (!INTENT.test(intentId)) { pending++; continue; }
    const intent = await stripeGet("payment_intents/" + encodeURIComponent(intentId), secret);
    const intentMeta = object(intent.metadata);
    const chargeId = idOf(intent.latest_charge);
    if (!CHARGE.test(chargeId)) { pending++; continue; }
    const charge = await stripeGet("charges/" + encodeURIComponent(chargeId), secret);

    const valid = session.mode === "payment" &&
      session.status === "complete" && session.payment_status === "paid" &&
      session.currency === "gbp" && session.amount_total === 600 &&
      intent.id === intentId && intent.livemode === false &&
      intent.status === "succeeded" && intent.amount_received === 600 &&
      intent.currency === "gbp" &&
      intentMeta.urbanfold_environment === "STAGING_ONLY" &&
      intentMeta.urbanfold_buyer_uid === user.id &&
      charge.id === chargeId && charge.livemode === false &&
      charge.payment_intent === intentId && charge.paid === true &&
      charge.captured === true && charge.amount === 600 &&
      charge.currency === "gbp" &&
      charge.amount_refunded === 0 && charge.refunded === false &&
      charge.disputed === false;
    if (!valid) { ineligible++; continue; }

    // Order is deliberate: record_survey_purchase is idempotent and enforces
    // unique Checkout Session and PaymentIntent ownership. If approval fails,
    // the purchase remains recorded but is NOT an eligible test credit.
    // Retry of this endpoint safely continues after an interrupted approval.
    const { error: recordError } = await db.rpc("record_survey_purchase", {
      session_id: sessionId, intent_id: intentId, buyer_id: user.id,
      paid_amount: 600, paid_currency: "gbp", is_live: false,
    });
    if (recordError) return respond({
      verified: true, approved: false, error: "Staging purchase record rejected.",
    }, 409);

    // Approval table is proposed in PR #10 and is NOT deployed yet.
    // Its RLS and grants exclude ordinary clients from inserting approvals.
    // UPSERT is unnecessary: existing approvals remain immutable.
    const { error: approvalError } = await db.from("staging_approved_test_survey_credits")
      .upsert({
        checkout_session_id: sessionId, proof_kind: "stripe_test_payment_verified",
      }, { onConflict: "checkout_session_id", ignoreDuplicates: true });
    if (approvalError) return respond({
      verified: true, approved: false,
      error: "Purchase recorded, but credit approval is pending server review.",
    }, 503);
    const { error: attestationError } = await db.rpc("attest_staging_survey_credit", {
      session_id: sessionId, intent_id: intentId, buyer_id: user.id,
    });
    if (attestationError) return respond({
      verified: true, approved: false, error: "Recent staging credit verification could not be recorded.",
    }, 503);
    approved++;
    }
    return respond({ test_mode: true, checked: Math.min(tracked.length, 5),
      approved_count: approved, pending, ineligible, additional_attempts: tracked.length > 5 });
  } catch {
    return respond({ verified: false, approved: false,
      error: "Stripe test verification unavailable; credit not approved." }, 503);
  }
});
