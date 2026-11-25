-- L1: harden the SECURITY DEFINER invite-token lookup. A SECURITY DEFINER function runs with its owner's rights,
-- so it must not resolve names through a search_path the caller can influence: pg_catalog first (built-ins can't be
-- shadowed), pg_temp last (the caller's temporary objects can't be picked up), and every table schema-qualified.
CREATE OR REPLACE FUNCTION public.app_invitation_by_token_hash(p_token_hash text)
  RETURNS TABLE ("id" text, "shopId" text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT i."id", i."shopId" FROM public."invitations" i WHERE i."tokenHash" = p_token_hash $$;
REVOKE ALL ON FUNCTION public.app_invitation_by_token_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_invitation_by_token_hash(text) TO repairos_app;
