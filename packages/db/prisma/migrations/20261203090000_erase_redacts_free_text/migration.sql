-- Code review H2 / tech lead decision A11-b: erasure redacts the customer's identifiers in free text.
--
-- app_erase_customer (re-created below) now also replaces every occurrence of the erased customer's names, email,
-- address lines, postcode, IMEI/serial and phone numbers with '[erased]' in:
--   tickets."description" / "conditionNotes" / "cancelNote" / "accessoriesOther", ticket_issues."label",
--   ticket_notes."body", ticket_events."data" (every string value, recursively) and audit_logs."before"/"after"
--   (every string value, recursively; the payload is no longer replaced wholesale by {"redacted": true}).
--
-- Matching rules (the trade-off between leaving an identifier behind and destroying unrelated text):
--   * Words and phrases match case-insensitively on whole-word boundaries only (no letter, digit or "_" directly
--     before or after), with any run of whitespace inside a phrase. Values shorter than 2 characters are never
--     matched (a lone initial "Y" would hit every "y"). A 2-character first name ("Al") still matches the whole word
--     "Al"/"AL" but not "also" or "all"; a name that is also a common word ("Will", "May", "Bill") IS redacted
--     wherever it stands as a word in this customer's own records: on an erasure request we prefer losing a few
--     ordinary words in the repair notes to keeping the person's name.
--   * "Strong" values identify the customer on their own: the full display name (person with first + last, or a
--     business), business name, business contact name, email, address lines, IMEI, serial (each 4+ characters)
--     and phone numbers. "Weak" values are single names (first name, last name, each word of the contact name) and
--     the postcode, which may well belong to someone else.
--   * Rows that belong to the customer (their tickets with issues/notes/events, and audit rows about the customer,
--     their devices or their tickets) are redacted for strong AND weak values. Every other row of the shop is
--     redacted for strong values only, so erasing "Ali Khan" removes "Ali Khan" from another customer's note but
--     not the staff member "Khan" mentioned there.
--   * Phones: for each of the customer's numbers we look for the full international digits (447911123456), the
--     national significant number (7911123456) and, for UK/PK, the trunk form (07911123456). A text is checked
--     against a digits-only copy of itself (so "(212) 255-4321" and "+44 7911 123456" are found), then the number
--     is replaced where it stands: an optional "+" / "(" and up to 3 non-alphanumeric separators between digits
--     ("(212) 255-4321", "212.255.4321", "+1 212-255-4321"); if the digits-only copy still contains the number
--     after that (unusual separators), a second pass allows up to 8 non-digit characters between digits. A number
--     is never matched inside a longer run of digits. National numbers shorter than 7 digits are not used. In rows
--     that are not the customer's, a cheap pre-filter first requires the last 4 digits written together.
--   * Cost: one pass over the shop's tickets, issues, notes, events and audit rows with LIKE pre-filters (about 1.5 s
--     for 100k tickets / 420k events on the perf dataset); only matching rows are run through the regular expressions.
--   * Longer values are replaced first, so "Zelda Quixote" becomes one "[erased]", not "[erased] [erased]".
--   * Note bodies keep the 2000-character CHECK (truncated in the rare case "[erased]" makes one longer).
-- Not redacted: city and region (too common to match safely; the customer row itself is cleared), ticket numbers,
-- device brand/model, and other shops' data. Text is matched as written: an accented or misspelt variant of a name
-- is not found.

-- Escapes the ARE special characters of a value so it can be embedded in a regular expression literally.
CREATE OR REPLACE FUNCTION app_regex_escape(p_value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT regexp_replace(p_value, '([.^$*+?(){}|\[\]\\])', '\\\1', 'g') $$;

-- Whole-word, whitespace-tolerant pattern for a name/email/address value (NULL when shorter than p_min chars).
CREATE OR REPLACE FUNCTION app_erase_word_pattern(p_value text, p_min integer) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE WHEN char_length(v) >= p_min
              THEN '(?<![[:alnum:]_])' || replace(public.app_regex_escape(v), ' ', '\s+') || '(?![[:alnum:]_])' END
  FROM (SELECT regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g') AS v) x
$$;

-- Pattern for a phone digit string with at most p_gap separator characters of class p_sep between digits.
CREATE OR REPLACE FUNCTION app_erase_phone_pattern(p_digits text, p_sep text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT '(?<![0-9])\+?\(?' || array_to_string(regexp_split_to_array(p_digits, ''), p_sep) || '(?![0-9])'
$$;

-- Replaces every match of p_patterns (case-insensitive) and of the phone digit strings p_phones (longest first)
-- with '[erased]'. NULL in → NULL out.
CREATE OR REPLACE FUNCTION app_redact_text(p_text text, p_patterns text[], p_phones text[]) RETURNS text
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE COST 10000 -- expensive: the planner checks the cheap pre-filter first
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  t   text := p_text;
  pat text;
  d   text;
BEGIN
  IF t IS NULL OR t = '' THEN
    RETURN t;
  END IF;
  FOREACH pat IN ARRAY coalesce(p_patterns, '{}') LOOP
    t := regexp_replace(t, pat, '[erased]', 'gi');
  END LOOP;
  FOREACH d IN ARRAY coalesce(p_phones, '{}') LOOP
    IF strpos(regexp_replace(t, '[^0-9]', '', 'g'), d) > 0 THEN
      t := regexp_replace(t, public.app_erase_phone_pattern(d, '[^[:alnum:]]{0,3}'), '[erased]', 'g');
      IF strpos(regexp_replace(t, '[^0-9]', '', 'g'), d) > 0 THEN
        t := regexp_replace(t, public.app_erase_phone_pattern(d, '[^0-9]{0,8}'), '[erased]', 'g');
      END IF;
    END IF;
  END LOOP;
  RETURN t;
END
$$;

-- app_redact_text applied to every string value of a JSON document (keys and non-string values unchanged).
CREATE OR REPLACE FUNCTION app_redact_jsonb(p_doc jsonb, p_patterns text[], p_phones text[]) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE COST 10000 -- expensive: the planner checks the cheap pre-filter first
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RETURN CASE jsonb_typeof(p_doc)
    WHEN 'string' THEN to_jsonb(public.app_redact_text(p_doc #>> '{}', p_patterns, p_phones))
    WHEN 'object' THEN coalesce(
      (SELECT jsonb_object_agg(e.key, public.app_redact_jsonb(e.value, p_patterns, p_phones)) FROM jsonb_each(p_doc) AS e),
      '{}'::jsonb)
    WHEN 'array' THEN coalesce(
      (SELECT jsonb_agg(public.app_redact_jsonb(a.value, p_patterns, p_phones) ORDER BY a.ord)
         FROM jsonb_array_elements(p_doc) WITH ORDINALITY AS a(value, ord)),
      '[]'::jsonb)
    ELSE p_doc
  END;
END
$$;

-- Cheap pre-filter for the shop's rows that are not the customer's (every ticket, issue, note and timeline event of
-- the shop is looked at): may p_text contain a strong value (p_token_likes: '%<longest word of the value>%',
-- lower-cased) or one of the phones (p_last4_likes: its last 4 digits appear literally, AND p_phone_likes: the
-- digits-only copy contains it)? A superset test: matching rows then go through app_redact_text. A phone written
-- with a separator inside its last 4 digits ("255-43 21") is therefore only found in the customer's own records.
-- One expression without sub-queries and no SET clause, so the planner inlines it (it only runs inside
-- app_erase_customer, which pins search_path); pass '{}' rather than NULL arrays.
CREATE OR REPLACE FUNCTION app_erase_may_match(p_text text, p_token_likes text[], p_last4_likes text[], p_phone_likes text[])
  RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT p_text IS NOT NULL AND (
    lower(p_text) LIKE ANY (p_token_likes)
    OR (p_text LIKE ANY (p_last4_likes) AND regexp_replace(p_text, '[^0-9]', '', 'g') LIKE ANY (p_phone_likes))
  )
$$;

REVOKE ALL ON FUNCTION app_regex_escape(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_erase_word_pattern(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_erase_phone_pattern(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_redact_text(text, text[], text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_redact_jsonb(jsonb, text[], text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_erase_may_match(text, text[], text[], text[]) FROM PUBLIC;

-- ---------- Erasure (CU9, A11 + tech lead clarification + A11-b) ----------
-- Anonymises one customer of the CURRENT shop, in the caller's transaction:
--   * free text: identifiers redacted as described at the top of this migration (BEFORE the values are cleared);
--   * customer: names, email, address, notes, tags, preferred contact, consent state and service opt-outs cleared;
--     displayName "Erased customer"; erasedAt set; archived. "searchText" is generated, so it is cleared too;
--   * phones and consent history deleted;
--   * devices keep type, brand and model; IMEI, serial, colour, notes and the passcode are removed;
--   * tickets, ticket notes and the timeline are kept as repair records (A11), redacted.
-- Raises CUSTOMER_NOT_FOUND, CUSTOMER_ERASED or CUSTOMER_HAS_OPEN_TICKETS (DETAIL = count). The customer row is
-- locked first, so a concurrent check-in, ticket move or device edit for the same customer either finishes before
-- (and is counted / redacted) or waits.
-- SECURITY DEFINER because the app role may not UPDATE audit_logs or ticket_events (append-only); every statement
-- filters by app_current_shop_id(). Returns counts only (for the customer.erased audit event).
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
