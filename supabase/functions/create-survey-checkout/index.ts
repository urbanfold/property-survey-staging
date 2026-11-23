// Staging-only checkout preparation. NOT deployed; requires separate review.
// Never copy this function or its Stripe keys into production.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.10";

const STAGING_URL = "https://hexhtduvqzleoazusskh.supabase.co";
const EXPECTED_ORIGIN = "https://urbanfold.github.io";
const STAGING_SITE = "https://urbanfold.github.io/property-survey-staging/";
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEST_SESSION_ID = /^cs_test_[A-Za-z0-9]+$/;

function response(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": EXPECTED_ORIGIN,
      "access-control-allow-headers": "authorization,apikey,content-type",
      "access-control-allow-methods": "POST,OPTIONS",
      "vary": "Origin",
    },
  });
}

Deno.serve(async (request) => {
  // Fail closed if accidentally deployed to a non-staging Supabase project.
  if (Deno.env.get("SUPABASE_URL") !== STAGING_URL) {
    return response({ error: "Staging environment only." }, 503);
  }
  if (request.headers.get("origin") !== EXPECTED_ORIGIN) {
    return response({ error: "Origin not allowed." }, 403);
  }
  if (request.method === "OPTIONS") return response({});
  if (request.method !== "POST") return response({ error: "POST required." }, 405);

  const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") || "");
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!bearer || !anon) return response({ error: "Sign in required." }, 401);

  const supabase = createClient(STAGING_URL, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userError } = await supabase.auth.getUser(bearer[1]);
  if (userError || !user || !user.email || !user.email_confirmed_at) {
    return response({ error: "A confirmed staging account is required." }, 403);
  }

  let payload: unknown;
  try { payload = await request.json(); } catch {
    return response({ error: "Invalid request." }, 400);
  }
  const attemptId = typeof payload === "object" && payload !== null && "attempt_id" in payload
    ? (payload as Record<string, unknown>).attempt_id : null;
  if (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId)) {
    return response({ error: "Invalid checkout attempt." }, 400);
  }

  const secret = Deno.env.get("STAGING_STRIPE_CHECKOUT_SECRET_KEY") || "";
  if (!/^(?:sk_test_|rk_test_)[A-Za-z0-9]+$/.test(secret)) {
    return response({ error: "Stripe test checkout is unavailable." }, 503);
  }

  const params = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "gbp",
    "line_items[0][price_data][unit_amount]": "600",
    "line_items[0][price_data][product_data][name]": "Urbanfold additional survey — STAGING TEST",
    client_reference_id: user.id,
    customer_email: user.email,
    "metadata[urbanfold_environment]": "STAGING_ONLY",
    "metadata[urbanfold_buyer_uid]": user.id,
    "metadata[urbanfold_checkout_purpose]": "staging_survey_extra_credit",
    "payment_intent_data[metadata][urbanfold_environment]": "STAGING_ONLY",
    "payment_intent_data[metadata][urbanfold_buyer_uid]": user.id,
    success_url: STAGING_SITE + "?payment=success&checkout_session_id={CHECKOUT_SESSION_ID}",
    cancel_url: STAGING_SITE + "?payment=cancelled",
  });

  let stripe: Response;
  try {
    stripe = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + secret,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": "urbanfold-staging-survey-" + user.id + "-" + attemptId,
      },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return response({ error: "Stripe sandbox connection unavailable." }, 503);
  }
  if (!stripe.ok) {
    // Never return Stripe's raw error body or any credentials.
    return response({ error: "Stripe sandbox checkout could not be prepared." }, 503);
  }

  let checkout: Record<string, unknown>;
  try { checkout = await stripe.json(); } catch {
    return response({ error: "Invalid Stripe sandbox response." }, 503);
  }

  if (checkout.livemode !== false || checkout.mode !== "payment" ||
      checkout.amount_total !== 600 || checkout.currency !== "gbp" ||
      checkout.client_reference_id !== user.id ||
      typeof checkout.id !== "string" || !TEST_SESSION_ID.test(checkout.id) ||
      typeof checkout.url !== "string") {
    return response({ error: "Stripe checkout failed safety validation." }, 503);
  }
  let checkoutUrl: URL;
  try { checkoutUrl = new URL(checkout.url); } catch {
    return response({ error: "Invalid Stripe checkout URL." }, 503);
  }
  if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.stripe.com") {
    return response({ error: "Untrusted checkout URL." }, 503);
  }
  // This does not grant a credit. Separate payment verification and staging-only
  // allowance logic must be reviewed before enabling redemption in any environment.
  return response({ url: checkoutUrl.href, test_mode: true, amount_minor: 600,
    currency: "gbp", checkout_session_id: checkout.id, credit_granted: false });
});
