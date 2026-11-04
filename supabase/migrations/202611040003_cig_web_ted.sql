-- Dati di origine degli avvisi, senza modificare note o stato delle gare già salvate.
ALTER TABLE public.cig_web_notices ADD COLUMN external_id text;
ALTER TABLE public.cig_web_notices ADD COLUMN official_url text;
ALTER TABLE public.cig_web_notices ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE public.cig_web_notices ADD COLUMN cpv text NOT NULL DEFAULT '';
ALTER TABLE public.cig_web_notices ADD COLUMN published_on date;
ALTER TABLE public.cig_web_notices ADD CONSTRAINT cig_web_notices_external_id_length CHECK (external_id IS NULL OR char_length(external_id) <= 100);
ALTER TABLE public.cig_web_notices ADD CONSTRAINT cig_web_notices_official_url_length CHECK (official_url IS NULL OR char_length(official_url) <= 2000);
ALTER TABLE public.cig_web_notices ADD CONSTRAINT cig_web_notices_description_length CHECK (char_length(description) <= 10000);
ALTER TABLE public.cig_web_notices ADD CONSTRAINT cig_web_notices_cpv_length CHECK (char_length(cpv) <= 1000);
CREATE UNIQUE INDEX cig_web_notices_owner_source_external_idx ON public.cig_web_notices(owner_id, source, external_id) WHERE external_id IS NOT NULL;
