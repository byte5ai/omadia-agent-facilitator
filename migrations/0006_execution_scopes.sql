-- Execution scopes and the lifecycle names of the specification (1.4.0).
--
-- Every action of a facilitation (a model turn, a post, a private message, a
-- card update, a check) is drawn from an execution scope the kernel keeps
-- (kernel #2090). The kernel is the authority; this table is what the engine
-- remembers of the scopes it opened, so that it knows which one an action is
-- drawn from without asking for the list every time, and across a restart.
CREATE TABLE IF NOT EXISTS plg_omadia_agent_facilitator_scopes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No foreign key: the `configuring` scope is opened, and recorded here,
  -- before the facilitation it is for is stored.
  facilitation_id uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('configuring', 'active', 'closing', 'scheduling', 'follow_up')),
  -- The closing event or the agreed meeting; '' for the other kinds.
  event_id        text NOT NULL DEFAULT '',
  -- The kernel's id of the scope.
  scope_id        text NOT NULL,
  state           text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'ended')),
  deadline        timestamptz NOT NULL,
  -- The people registered on the scope, as a key; the kernel is told again
  -- only when it changes.
  people_key      text,
  opened_at       timestamptz NOT NULL,
  ended_at        timestamptz,
  end_reason      text,
  UNIQUE (facilitation_id, kind, event_id)
);
CREATE INDEX IF NOT EXISTS plg_omadia_agent_facilitator_scopes_open ON plg_omadia_agent_facilitator_scopes (facilitation_id) WHERE state = 'open';

-- A session is `scheduled`, `live`, `closed` or `cancelled` (specification
-- 5.2). Before 1.4.0 the engine wrote `running` and `ended`.
ALTER TABLE plg_omadia_agent_facilitator_sessions DROP CONSTRAINT IF EXISTS plg_omadia_agent_facilitator_sessions_status_check;
UPDATE plg_omadia_agent_facilitator_sessions SET status = 'live' WHERE status = 'running';
UPDATE plg_omadia_agent_facilitator_sessions SET status = 'closed' WHERE status = 'ended';
ALTER TABLE plg_omadia_agent_facilitator_sessions
  ADD CONSTRAINT plg_omadia_agent_facilitator_sessions_status_check CHECK (status IN ('scheduled', 'live', 'confirming', 'closed', 'cancelled'));
