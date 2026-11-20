-- Closing events, result status and delivery status (specification 5.2,
-- 5.6, 5.11; #2064, #2078, #2063 criterion 38).
--
-- Every closing event of a facilitation (the result of `concluding`, an
-- abort, the close of a session) is one row here. It holds the frozen
-- closing document with its version and runs the closing procedure:
--
--   waiting       only the result: until every session closing that needs
--                 confirmation has ended
--   delivery      the closing document reaches its conversation (<= 7 days)
--   confirmation  only where required: the consent window (default 24 h, at
--                 most 72 h) from the confirmed delivery, with an electorate
--                 verified fresh (hourly retries, at most 24 h)
--   dispatch      the final protocol to its recipients (<= 7 days)
--
-- each limit counted from the start of its part, all inside the absolute
-- limit of 30 days from the event. The result status (published, confirmed,
-- not confirmed with its reason, aborted) and the delivery status
-- (delivered, not delivered) are separate.
CREATE TABLE IF NOT EXISTS plg_omadia_agent_facilitator_closings (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitation_id        uuid NOT NULL REFERENCES plg_omadia_agent_facilitator_facilitations (id) ON DELETE CASCADE,
  kind                   text NOT NULL CHECK (kind IN ('result', 'abort', 'session')),
  session_id             uuid REFERENCES plg_omadia_agent_facilitator_sessions (id) ON DELETE CASCADE,
  -- The event id of the closing's `closing` scope at the kernel ('result',
  -- 'abort', 'session:<id>').
  event_id               text NOT NULL,
  -- The closing document as it was frozen, and its version. A later version
  -- (a re-delivery after a stop) replaces the text, never the history.
  document               text NOT NULL,
  document_version       integer NOT NULL DEFAULT 1,
  requires_confirmation  boolean NOT NULL DEFAULT false,
  part                   text NOT NULL DEFAULT 'delivery' CHECK (part IN ('waiting', 'delivery', 'confirmation', 'dispatch', 'done')),
  part_started_at        timestamptz NOT NULL,
  result_status          text CHECK (result_status IN ('published', 'confirmed', 'not_confirmed', 'aborted')),
  result_reason          text CHECK (result_reason IN ('objection', 'electorate_unverified', 'not_delivered', 'stopped')),
  -- The standing objections at the window's end: [{principal, reason, messageId}].
  objections             jsonb NOT NULL DEFAULT '[]'::jsonb,
  delivery_status        text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'delivered', 'not_delivered')),
  delivered_at           timestamptz,
  window_ends_at         timestamptz,
  -- Until when the electorate is queried again (hourly) after the window.
  verify_until           timestamptz,
  -- The result status was set: the document is final.
  final_at               timestamptz,
  dispatch_until         timestamptz,
  absolute_until         timestamptz NOT NULL,
  started_at             timestamptz NOT NULL,
  ended_at               timestamptz,
  UNIQUE (facilitation_id, event_id),
  CHECK ((kind = 'session') = (session_id IS NOT NULL)),
  -- A reason exactly for "not confirmed".
  CHECK ((result_status IS NOT DISTINCT FROM 'not_confirmed') = (result_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS plg_omadia_agent_facilitator_closings_open ON plg_omadia_agent_facilitator_closings (facilitation_id) WHERE ended_at IS NULL;

-- A closing document in the outbox carries its closing event and document
-- version instead of a `state_version` (5.6): it is retried while its
-- closing scope is valid, whatever the moderation's state is by then.
ALTER TABLE plg_omadia_agent_facilitator_outbox ADD COLUMN IF NOT EXISTS closing_id uuid;
ALTER TABLE plg_omadia_agent_facilitator_outbox ADD COLUMN IF NOT EXISTS document_version integer;

-- When the facilitation reached `ended` (or `aborted`): retention counts
-- from here, never from `closed` (5.8).
ALTER TABLE plg_omadia_agent_facilitator_facilitations ADD COLUMN IF NOT EXISTS ended_at timestamptz;
-- Existing rows: an abort or a close without follow-up ended at the close; a
-- follow-up that ran ended when its `followup_ended` event was written.
UPDATE plg_omadia_agent_facilitator_facilitations f SET ended_at = CASE
    WHEN f.phase = 'closed' AND f.followup_state = 'ended' THEN coalesce(
      (SELECT max(e.occurred_at) FROM plg_omadia_agent_facilitator_events e WHERE e.facilitation_id = f.id AND e.kind = 'followup_ended'),
      greatest(f.closed_at, f.followup_ends_at))
    ELSE f.closed_at END
 WHERE f.ended_at IS NULL AND f.closed_at IS NOT NULL AND (f.phase = 'aborted' OR f.followup_state <> 'active');

-- How much a stakeholder may know of what the protocol leaves out for them
-- (5.8, AVE 5.11): `full` gets every part it may know, `existence` a note
-- that something was left out, `none` neither content nor a hint.
ALTER TABLE plg_omadia_agent_facilitator_stakeholders ADD COLUMN IF NOT EXISTS disclosure text NOT NULL DEFAULT 'existence';
ALTER TABLE plg_omadia_agent_facilitator_stakeholders DROP CONSTRAINT IF EXISTS plg_omadia_agent_facilitator_stakeholders_disclosure_check;
ALTER TABLE plg_omadia_agent_facilitator_stakeholders
  ADD CONSTRAINT plg_omadia_agent_facilitator_stakeholders_disclosure_check CHECK (disclosure IN ('full', 'existence', 'none'));
