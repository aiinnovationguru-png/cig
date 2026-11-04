-- Archivio di prova web isolato dal resto del progetto Supabase.
-- Non esegue migrazioni dei dati desktop né concede accesso anonimo.
CREATE TABLE public.cig_web_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 500),
  buyer text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  cig text NOT NULL DEFAULT '',
  deadline date,
  estimated_value numeric(18,2) CHECK (estimated_value IS NULL OR estimated_value >= 0),
  source text NOT NULL DEFAULT 'manuale' CHECK (source IN ('manuale', 'ted', 'anac')),
  stage text CHECK (stage IS NULL OR stage IN ('valutare','preparare','presentato','vinto','perso')),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cig_web_notices_owner_created_idx ON public.cig_web_notices (owner_id, created_at DESC);
ALTER TABLE public.cig_web_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cig_web_notices FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cig_web_notices TO authenticated;
CREATE POLICY cig_web_notices_select_own ON public.cig_web_notices FOR SELECT TO authenticated USING ((SELECT auth.uid()) = owner_id);
CREATE POLICY cig_web_notices_insert_own ON public.cig_web_notices FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = owner_id);
CREATE POLICY cig_web_notices_update_own ON public.cig_web_notices FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = owner_id) WITH CHECK ((SELECT auth.uid()) = owner_id);
CREATE POLICY cig_web_notices_delete_own ON public.cig_web_notices FOR DELETE TO authenticated USING ((SELECT auth.uid()) = owner_id);
