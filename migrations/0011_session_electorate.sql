-- The electorate of a session (specification 5.5; #2076).
--
-- Membership is tracked per scope: a linked session conversation has its own
-- members. `session_participants` now lists every member of the session
-- conversation the engine knows of: session-only participants (`home` false,
-- as before) and home participants who are in it (`home` true). Leaving the
-- meeting chat ends only the session membership.
ALTER TABLE plg_omadia_agent_facilitator_session_participants ADD COLUMN IF NOT EXISTS home boolean NOT NULL DEFAULT false;

-- Where a session's list of members comes from, fixed when it is linked:
-- 'platform_roster' (the meeting chat's member list was complete then) or
-- 'declared_list' (whoever the channel names or who writes there; nobody is
-- removed by others).
ALTER TABLE plg_omadia_agent_facilitator_sessions ADD COLUMN IF NOT EXISTS electorate_source text;
ALTER TABLE plg_omadia_agent_facilitator_sessions DROP CONSTRAINT IF EXISTS plg_omadia_agent_facilitator_sessions_electorate_source_check;
ALTER TABLE plg_omadia_agent_facilitator_sessions
  ADD CONSTRAINT plg_omadia_agent_facilitator_sessions_electorate_source_check CHECK (electorate_source IS NULL OR electorate_source IN ('platform_roster', 'declared_list'));

-- A step run inside a live session may declare that session's participants
-- as its electorate instead of the home participants.
ALTER TABLE plg_omadia_agent_facilitator_steps ADD COLUMN IF NOT EXISTS electorate_session_id uuid REFERENCES plg_omadia_agent_facilitator_sessions (id) ON DELETE SET NULL;
