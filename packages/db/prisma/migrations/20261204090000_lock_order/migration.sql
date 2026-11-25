-- Lock order for Sprint 2 writes (packages/db/README.md, "Lock order"; fix for the erase vs reopen deadlock).
--
-- app_erase_customer (re-created below, otherwise unchanged from 20261203090000_erase_redacts_free_text) used to
-- lock the customer and then write the customer's tickets in scan order, while the API's reopen locked the ticket
-- and then the customer: the two could deadlock (40P01 → 500). The API now takes customer → ticket → device
-- everywhere, and this function locks, right after the customer, every ticket it may update in id order and then
-- the customer's devices in id order, before writing anything.

CREATE OR REPLACE FUNCTION app_erase_customer(p_customer_id text) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_shop       text := public.app_current_shop_id();
  c            public.customers%ROWTYPE;
  v_open       integer;
  v_tickets    integer;
  v_device_ids text[];
  v_ticket_ids text[];
  v_strong     text[];   -- patterns of strong values, longest value first
  v_all        text[];   -- patterns of strong + weak values, longest value first
  v_tokens     text[];   -- longest word of each strong value, lower-cased (pre-filter for other rows)
  v_token_likes text[];  -- the same as LIKE patterns
  v_last4_likes text[];  -- each phone's last 4 digits as a LIKE pattern
  v_phone_likes text[];  -- each phone digit string as a LIKE pattern
  v_phones     text[];   -- phone digit strings, longest first
  v_phones_n   integer;
  v_consents   integer;
  v_devices    integer;
  v_audit      integer;
  v_text       integer := 0;
  v_n          integer;
BEGIN
  IF v_shop IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND';
  END IF;
  -- Lock order (packages/db/README.md): customer → tickets (sorted) → devices (sorted). Every ticket write of this
  -- customer locks the customer first, so while we hold it none of its tickets can be reopened, moved or created.
  SELECT * INTO c FROM public.customers WHERE "id" = p_customer_id AND "shopId" = v_shop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND';
  END IF;
  IF c."erasedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'CUSTOMER_ERASED';
  END IF;
  SELECT count(*) FILTER (WHERE "statusCategory" <> 'CLOSED'), count(*), coalesce(array_agg("id"), '{}')
    INTO v_open, v_tickets, v_ticket_ids
    FROM public.tickets WHERE "shopId" = v_shop AND "customerId" = p_customer_id;
  IF v_open > 0 THEN
    RAISE EXCEPTION 'CUSTOMER_HAS_OPEN_TICKETS' USING DETAIL = v_open::text;
  END IF;

  SELECT coalesce(array_agg("id"), '{}') INTO v_device_ids
    FROM public.devices WHERE "shopId" = v_shop AND "customerId" = p_customer_id;

  -- Values → patterns. strong = identifies the customer on its own (4+ chars); weak = single names, postcode (2+).
  WITH vals(v, strong) AS (
    SELECT x.v, x.strong
    FROM unnest(
      ARRAY[c."displayName", c."businessName", c."businessContactName", c."email", c."addressLine1", c."addressLine2",
            c."firstName", c."lastName", c."postcode"],
      ARRAY[c."kind" = 'BUSINESS' OR strpos(btrim(c."displayName"), ' ') > 0, true, true, true, true, true,
            false, false, false]
    ) AS x(v, strong)
    UNION ALL SELECT w, false FROM regexp_split_to_table(coalesce(c."businessContactName", ''), '\s+') AS w
    UNION ALL SELECT "imei", true FROM public.devices WHERE "shopId" = v_shop AND "customerId" = p_customer_id
    UNION ALL SELECT "serial", true FROM public.devices WHERE "shopId" = v_shop AND "customerId" = p_customer_id
  ),
  pats AS (
    SELECT public.app_erase_word_pattern(v, CASE WHEN strong THEN 4 ELSE 2 END) AS p, strong, char_length(btrim(v)) AS len,
           (SELECT lower(w) FROM regexp_split_to_table(btrim(v), '\s+') AS w ORDER BY char_length(w) DESC, w LIMIT 1) AS tok
    FROM vals WHERE v IS NOT NULL
  ),
  uniq AS (
    SELECT p, bool_or(strong) AS strong, max(len) AS len, max(tok) AS tok FROM pats WHERE p IS NOT NULL GROUP BY p
  )
  SELECT coalesce(array_agg(p ORDER BY len DESC, p) FILTER (WHERE strong), '{}'),
         coalesce(array_agg(p ORDER BY len DESC, p), '{}'),
         coalesce(array_agg(DISTINCT tok) FILTER (WHERE strong), '{}')
    INTO v_strong, v_all, v_tokens
    FROM uniq;

  -- Phone digit strings: international digits, national significant number (+ trunk "0" form for UK/PK).
  SELECT coalesce(array_agg(DISTINCT d ORDER BY d), '{}') INTO v_phones
  FROM (
    SELECT p."digits" AS d FROM public.customer_phones p WHERE p."shopId" = v_shop AND p."customerId" = p_customer_id
    UNION ALL
    SELECT CASE WHEN n.cc IN ('44', '92') THEN '0' || n.nsn END FROM (
      SELECT substr(p."digits", char_length(cc.cc) + 1) AS nsn, cc.cc
      FROM public.customer_phones p
      JOIN (VALUES ('1'), ('44'), ('92')) AS cc(cc) ON p."digits" LIKE cc.cc || '%'
      WHERE p."shopId" = v_shop AND p."customerId" = p_customer_id
        AND (cc.cc <> '1' OR char_length(p."digits") = 11)
    ) n
    UNION ALL
    SELECT substr(p."digits", char_length(cc.cc) + 1)
    FROM public.customer_phones p
    JOIN (VALUES ('1'), ('44'), ('92')) AS cc(cc) ON p."digits" LIKE cc.cc || '%'
    WHERE p."shopId" = v_shop AND p."customerId" = p_customer_id
      AND (cc.cc <> '1' OR char_length(p."digits") = 11)
  ) x
  WHERE d IS NOT NULL AND char_length(d) >= 7;
  -- longest first, so the international form is replaced before the national number inside it
  SELECT coalesce(array_agg(d ORDER BY char_length(d) DESC, d), '{}') INTO v_phones FROM unnest(v_phones) AS d;
  v_token_likes := ARRAY(SELECT '%' || public.app_like_escape(tok) || '%' FROM unnest(v_tokens) AS tok);
  v_last4_likes := ARRAY(SELECT DISTINCT '%' || right(d, 4) || '%' FROM unnest(v_phones) AS d);
  v_phone_likes := ARRAY(SELECT '%' || d || '%' FROM unnest(v_phones) AS d);
  v_phones := CASE WHEN cardinality(v_phones) = 0 THEN NULL ELSE v_phones END;

  -- Every ticket the UPDATE below may write (the customer's own, plus other tickets whose text may mention them),
  -- locked up front in id order (FOR NO KEY UPDATE, like the API's ticket writes), then the customer's devices in id
  -- order. Other customers' tickets are locked without their customer row: safe, because a transaction holding a
  -- ticket never waits for a customer (customers come first) and tickets are always locked in id order.
  PERFORM 1 FROM public.tickets t
   WHERE t."shopId" = v_shop
     AND (t."customerId" = p_customer_id
          OR public.app_erase_may_match(concat_ws(' ', t."description", t."conditionNotes", t."cancelNote", t."accessoriesOther"), v_token_likes, v_last4_likes, v_phone_likes))
   ORDER BY t."id" COLLATE "C"
   FOR NO KEY UPDATE;
  PERFORM 1 FROM public.devices d
   WHERE d."shopId" = v_shop AND d."customerId" = p_customer_id
   ORDER BY d."id" COLLATE "C"
   FOR UPDATE;

  -- Tickets: the customer's own (strong + weak) and any other ticket of the shop that may mention them (strong).
  UPDATE public.tickets t
     SET "description"      = public.app_redact_text(t."description",      CASE WHEN t."customerId" = p_customer_id THEN v_all ELSE v_strong END, v_phones),
         "conditionNotes"   = public.app_redact_text(t."conditionNotes",   CASE WHEN t."customerId" = p_customer_id THEN v_all ELSE v_strong END, v_phones),
         "cancelNote"       = public.app_redact_text(t."cancelNote",       CASE WHEN t."customerId" = p_customer_id THEN v_all ELSE v_strong END, v_phones),
         "accessoriesOther" = public.app_redact_text(t."accessoriesOther", CASE WHEN t."customerId" = p_customer_id THEN v_all ELSE v_strong END, v_phones)
   WHERE t."shopId" = v_shop
     AND (t."customerId" = p_customer_id
          OR public.app_erase_may_match(concat_ws(' ', t."description", t."conditionNotes", t."cancelNote", t."accessoriesOther"), v_token_likes, v_last4_likes, v_phone_likes))
     AND (t."description", t."conditionNotes", t."cancelNote", t."accessoriesOther") IS DISTINCT FROM (
          public.app_redact_text(t."description",      CASE WHEN t."customerId" = p_customer_id THEN v_all ELSE v_strong END, v_phones),
          public.app_redact_text(t."conditionNotes",   CASE WHEN t."customerId" = p_customer_id THEN v_all ELSE v_strong END, v_phones),
          public.app_redact_text(t."cancelNote",       CASE WHEN t."customerId" = p_customer_id THEN v_all ELSE v_strong END, v_phones),
          public.app_redact_text(t."accessoriesOther", CASE WHEN t."customerId" = p_customer_id THEN v_all ELSE v_strong END, v_phones));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_text := v_text + v_n;

  UPDATE public.ticket_issues i
     SET "label" = public.app_redact_text(i."label", CASE WHEN i."ticketId" = ANY (v_ticket_ids) THEN v_all ELSE v_strong END, v_phones)
   WHERE i."shopId" = v_shop
     AND (i."ticketId" = ANY (v_ticket_ids) OR public.app_erase_may_match(i."label", v_token_likes, v_last4_likes, v_phone_likes))
     AND i."label" IS DISTINCT FROM public.app_redact_text(i."label", CASE WHEN i."ticketId" = ANY (v_ticket_ids) THEN v_all ELSE v_strong END, v_phones);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_text := v_text + v_n;

  UPDATE public.ticket_notes n
     SET "body" = left(public.app_redact_text(n."body", CASE WHEN n."ticketId" = ANY (v_ticket_ids) THEN v_all ELSE v_strong END, v_phones), 2000)
   WHERE n."shopId" = v_shop
     AND (n."ticketId" = ANY (v_ticket_ids) OR public.app_erase_may_match(n."body", v_token_likes, v_last4_likes, v_phone_likes))
     AND n."body" IS DISTINCT FROM left(public.app_redact_text(n."body", CASE WHEN n."ticketId" = ANY (v_ticket_ids) THEN v_all ELSE v_strong END, v_phones), 2000);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_text := v_text + v_n;

  UPDATE public.ticket_events e
     SET "data" = public.app_redact_jsonb(e."data", CASE WHEN e."ticketId" = ANY (v_ticket_ids) THEN v_all ELSE v_strong END, v_phones)
   WHERE e."shopId" = v_shop
     AND e."data" IS NOT NULL
     AND (e."ticketId" = ANY (v_ticket_ids) OR public.app_erase_may_match(e."data"::text, v_token_likes, v_last4_likes, v_phone_likes))
     AND e."data" IS DISTINCT FROM public.app_redact_jsonb(e."data", CASE WHEN e."ticketId" = ANY (v_ticket_ids) THEN v_all ELSE v_strong END, v_phones);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_text := v_text + v_n;

  -- Audit payloads: rows about the customer, their devices or their tickets get every value; other rows strong ones.
  WITH scoped AS (
    SELECT a."id",
           CASE WHEN (a."entityType" = 'Customer' AND a."entityId" = p_customer_id)
                  OR (a."entityType" = 'Device' AND a."entityId" = ANY (v_device_ids))
                  OR (a."entityType" = 'Ticket' AND a."entityId" = ANY (v_ticket_ids))
                THEN v_all ELSE v_strong END AS pats,
           a."before", a."after"
    FROM public.audit_logs a
    WHERE a."shopId" = v_shop
      AND (a."before" IS NOT NULL OR a."after" IS NOT NULL)
      AND (   (a."entityType" = 'Customer' AND a."entityId" = p_customer_id)
           OR (a."entityType" = 'Device' AND a."entityId" = ANY (v_device_ids))
           OR (a."entityType" = 'Ticket' AND a."entityId" = ANY (v_ticket_ids))
           OR public.app_erase_may_match(coalesce(a."before"::text, '') || ' ' || coalesce(a."after"::text, ''), v_token_likes, v_last4_likes, v_phone_likes))
  ), redacted AS (
    SELECT s."id", public.app_redact_jsonb(s."before", s.pats, v_phones) AS b, public.app_redact_jsonb(s."after", s.pats, v_phones) AS f,
           s."before", s."after"
    FROM scoped s
  )
  UPDATE public.audit_logs a
     SET "before" = r.b, "after" = r.f
    FROM redacted r
   WHERE a."id" = r."id" AND a."shopId" = v_shop
     AND (r.b IS DISTINCT FROM r."before" OR r.f IS DISTINCT FROM r."after");
  GET DIAGNOSTICS v_audit = ROW_COUNT;

  DELETE FROM public.customer_phones WHERE "shopId" = v_shop AND "customerId" = p_customer_id;
  GET DIAGNOSTICS v_phones_n = ROW_COUNT;
  DELETE FROM public.customer_consent_events WHERE "shopId" = v_shop AND "customerId" = p_customer_id;
  GET DIAGNOSTICS v_consents = ROW_COUNT;

  UPDATE public.devices
     SET "colour" = NULL, "imei" = NULL, "serial" = NULL, "notes" = NULL, "lockType" = 'NONE',
         "passcodeCiphertext" = NULL, "passcodeIv" = NULL, "passcodeTag" = NULL, "passcodeKeyVersion" = NULL,
         "passcodeSetAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
   WHERE "shopId" = v_shop AND "customerId" = p_customer_id;
  GET DIAGNOSTICS v_devices = ROW_COUNT;

  UPDATE public.customers
     SET "firstName" = NULL, "lastName" = NULL, "businessName" = NULL, "businessContactName" = NULL,
         "displayName" = 'Erased customer', "email" = NULL,
         "addressLine1" = NULL, "addressLine2" = NULL, "city" = NULL, "region" = NULL, "postcode" = NULL,
         "notes" = NULL, "tags" = '{}', "preferredChannel" = NULL,
         "serviceOptOutSms" = false, "serviceOptOutEmail" = false, "serviceOptOutWhatsapp" = false,
         "marketingSmsAt" = NULL, "marketingEmailAt" = NULL, "marketingWhatsappAt" = NULL,
         "erasedAt" = CURRENT_TIMESTAMP, "archivedAt" = coalesce("archivedAt", CURRENT_TIMESTAMP),
         "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = p_customer_id AND "shopId" = v_shop;

  RETURN jsonb_build_object('phones', v_phones_n, 'consentEvents', v_consents, 'devices', v_devices,
                            'tickets', v_tickets, 'auditRowsRedacted', v_audit, 'textRowsRedacted', v_text);
END
$$;
REVOKE ALL ON FUNCTION app_erase_customer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_erase_customer(text) TO repairos_app;
