-- Daily worker maintenance (code review H1 sweep, backlog "Clean up expired ticket idempotency keys").
-- The worker runs as the RLS-bound app role with no shop selected, so it sees no tenant rows. These two
-- SECURITY DEFINER functions are the only cross-shop entry points: each does one fixed, idempotent clean-up over
-- every shop, takes no shop-chosen input and returns a count only. Timestamps are compared in UTC, as Prisma writes
-- them (TIMESTAMP(3) without time zone).

-- H1 backstop: deletes the passcode of every device that no non-closed ticket uses, in shops whose
-- "deletePasscodeOnClose" setting is on (the close-time deletion can be skipped by data fixed by hand, scripts or a
-- bug). Passcodes set less than p_min_age ago are left alone (a passcode saved on the device form just before the
-- check-in). Each device is locked (SKIP LOCKED: a device busy in a request is retried the next day) and re-checked
-- in a new statement, so a ticket that a check-in or reopen committed meanwhile is seen. A `passcode_deleted`
-- timeline event (system, reason "closed": every ticket of the device is closed) goes on the device's most recently
-- closed ticket, if it has one. Returns the number of passcodes deleted.
CREATE OR REPLACE FUNCTION app_sweep_unused_passcodes(p_min_age interval) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r        record;
  v_ticket text;
  v_n      integer := 0;
  v_cutoff timestamp := (now() AT TIME ZONE 'UTC') - p_min_age;
BEGIN
  FOR r IN
    SELECT d."id", d."shopId"
    FROM public.devices d
    JOIN public.shop_ticket_settings s ON s."shopId" = d."shopId" AND s."deletePasscodeOnClose"
    WHERE d."passcodeKeyVersion" IS NOT NULL
      AND (d."passcodeSetAt" IS NULL OR d."passcodeSetAt" < v_cutoff)
      AND NOT EXISTS (SELECT 1 FROM public.tickets t
                      WHERE t."shopId" = d."shopId" AND t."deviceId" = d."id" AND t."statusCategory" <> 'CLOSED')
    ORDER BY d."shopId", d."id"
  LOOP
    PERFORM 1 FROM public.devices WHERE "id" = r."id" AND "shopId" = r."shopId" FOR UPDATE SKIP LOCKED;
    CONTINUE WHEN NOT FOUND;
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.tickets t
                          WHERE t."shopId" = r."shopId" AND t."deviceId" = r."id" AND t."statusCategory" <> 'CLOSED');
    UPDATE public.devices
       SET "passcodeCiphertext" = NULL, "passcodeIv" = NULL, "passcodeTag" = NULL, "passcodeKeyVersion" = NULL,
           "passcodeSetAt" = NULL
     WHERE "id" = r."id" AND "shopId" = r."shopId" AND "passcodeKeyVersion" IS NOT NULL
       AND ("passcodeSetAt" IS NULL OR "passcodeSetAt" < v_cutoff);
    CONTINUE WHEN NOT FOUND;
    v_n := v_n + 1;
    SELECT t."id" INTO v_ticket FROM public.tickets t
     WHERE t."shopId" = r."shopId" AND t."deviceId" = r."id"
     ORDER BY t."closedAt" DESC NULLS LAST, t."createdAt" DESC, t."id" DESC
     LIMIT 1;
    IF v_ticket IS NOT NULL THEN
      INSERT INTO public.ticket_events ("id", "shopId", "ticketId", "actorUserId", "type", "data", "createdAt")
      VALUES (gen_random_uuid()::text, r."shopId", v_ticket, NULL, 'passcode_deleted', '{"reason": "closed"}'::jsonb,
              now() AT TIME ZONE 'UTC');
    END IF;
  END LOOP;
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION app_sweep_unused_passcodes(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_sweep_unused_passcodes(interval) TO repairos_app;

-- Deletes check-in idempotency keys older than p_older_than (the API's IDEMPOTENCY_WINDOW_MINUTES: an older key is
-- never answered from, only replaced). Returns the number of rows deleted.
CREATE OR REPLACE FUNCTION app_purge_ticket_idempotency_keys(p_older_than interval) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  -- Never inside the API's 10-minute window (contracts IDEMPOTENCY_WINDOW_MINUTES), whatever the caller passes.
  DELETE FROM public.ticket_idempotency_keys
   WHERE "createdAt" < (now() AT TIME ZONE 'UTC') - GREATEST(p_older_than, interval '10 minutes');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION app_purge_ticket_idempotency_keys(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_purge_ticket_idempotency_keys(interval) TO repairos_app;
