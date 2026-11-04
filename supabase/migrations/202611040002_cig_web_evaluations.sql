-- Valutazioni web personali: i documenti vengono salvati solo su richiesta.
CREATE TABLE public.cig_web_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 500),
  report text NOT NULL CHECK (char_length(report) BETWEEN 1 AND 200000),
  criteria jsonb NOT NULL CHECK (jsonb_typeof(criteria) = 'array' AND pg_column_size(criteria) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cig_web_evaluations_owner_created_idx ON public.cig_web_evaluations(owner_id, created_at DESC);
ALTER TABLE public.cig_web_evaluations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cig_web_evaluations FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cig_web_evaluations TO authenticated;
CREATE POLICY cig_web_evaluations_select_own ON public.cig_web_evaluations FOR SELECT TO authenticated USING ((SELECT auth.uid()) = owner_id);
CREATE POLICY cig_web_evaluations_insert_own ON public.cig_web_evaluations FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = owner_id);
CREATE POLICY cig_web_evaluations_update_own ON public.cig_web_evaluations FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = owner_id) WITH CHECK ((SELECT auth.uid()) = owner_id);
CREATE POLICY cig_web_evaluations_delete_own ON public.cig_web_evaluations FOR DELETE TO authenticated USING ((SELECT auth.uid()) = owner_id);
