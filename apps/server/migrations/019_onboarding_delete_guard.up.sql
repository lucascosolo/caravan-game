-- Chunk 24 QA N1(b): a finished guide is permanent (migration 017), but 017 only guarded
-- UPDATE. As the app role, DELETE then INSERT ... 'welcome' reopened a finished guide. The
-- row may now only go with its account (ON DELETE CASCADE, once the account row is already
-- gone, as trip_cap_guard_delete does); TRUNCATE is refused like every guarded table.
-- Numbered 019 to stay clear of in-flight chunks; renumber on merge if needed.

CREATE FUNCTION account_onboarding_guard_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE id = OLD.account_id) THEN
    RAISE EXCEPTION 'account_onboarding (account %) may not be deleted while its account exists', OLD.account_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER account_onboarding_guard_delete BEFORE DELETE ON account_onboarding
  FOR EACH ROW EXECUTE FUNCTION account_onboarding_guard_delete();
CREATE TRIGGER account_onboarding_guard_truncate BEFORE TRUNCATE ON account_onboarding
  FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();
