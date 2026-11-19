-- 1.3.0: the plugin's tables live in the plugin's own schema (kernel #2088).
--
-- On an installation that ran 1.2.0 or earlier, the kernel moves the tables
-- out of the shared schema at the first activation of this version. A table
-- takes its trigger with it, but not the function the trigger calls: that one
-- stays behind where 0001 created it, owned by the kernel's database user.
-- The append-only rule of the event log would then depend on an object
-- outside the plugin's schema that the plugin's roles neither own nor may
-- change.
--
-- So the function is created here again, by unqualified name, which places it
-- in the plugin's schema (the search path of every statement the plugin
-- sends), and the trigger is bound to it. On a fresh installation 0001 has
-- already created both in the schema and this file changes nothing.
--
-- The function left behind is not dropped here: it does not belong to the
-- plugin's roles. Nothing refers to it after this file ran.

CREATE OR REPLACE FUNCTION plg_omadia_agent_facilitator_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'plg_omadia_agent_facilitator_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS plg_omadia_agent_facilitator_events_no_update ON plg_omadia_agent_facilitator_events;
CREATE TRIGGER plg_omadia_agent_facilitator_events_no_update
  BEFORE UPDATE ON plg_omadia_agent_facilitator_events
  FOR EACH ROW EXECUTE FUNCTION plg_omadia_agent_facilitator_events_append_only();
