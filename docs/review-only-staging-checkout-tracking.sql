-- STAGING REVIEW ONLY: do not execute in production.
-- Checkout references are persisted before redirect; no card data stored.
BEGIN;
CREATE TABLE public.staging_survey_checkout_attempts (
 checkout_session_id text PRIMARY KEY CHECK (checkout_session_id ~ '^cs_test_[A-Za-z0-9]+$'),
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 attempt_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,attempt_id)
);
CREATE INDEX staging_survey_checkout_attempts_owner_idx
 ON public.staging_survey_checkout_attempts(user_id,created_at DESC);
ALTER TABLE public.staging_survey_checkout_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staging_survey_checkout_attempts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.staging_survey_checkout_attempts TO service_role;
COMMIT;
