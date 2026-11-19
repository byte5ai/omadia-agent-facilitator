-- 1.3.0: the plugin's tables live in the plugin's own schema (kernel #2088).
--
-- On an installation that ran 1.2.0 or earlier, the kernel moves the plugin's
-- objects out of the shared schema at the first activation of this version:
-- the tables, and with them the function behind the trigger that keeps the
-- event log append-only.
--
-- This file is the safety net for that function. A table takes its trigger
-- along when it moves, but a trigger keeps calling the function it was bound
-- to wherever that function is; if the function ever stayed behind, the
-- append-only rule would depend on an object outside the plugin's schema
-- that the plugin's roles neither own nor may change. So the function is
-- created here by unqualified name, which places it in the plugin's schema
-- (the search path of every statement the plugin sends), and the trigger is
-- bound to it. Where the function is already in the schema (moved by the
-- kernel, or created there by 0001 on a fresh installation) this file
-- changes nothing.

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
