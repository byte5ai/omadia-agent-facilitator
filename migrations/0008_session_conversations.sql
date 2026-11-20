-- Linked session conversations, session closings and spoken contributions
-- (specification 5.2, 5.3, 6.3; #2076, #2077, #2089).
--
-- A live session may run in another conversation than the home one (the
-- chat of a scheduled meeting). It is linked on a request made inside that
-- conversation by a home participant, takes that conversation's own
-- reservation at the kernel, and is read as its session state allows
-- (scheduled: addressed messages, live and confirming: every message,
-- closed: nothing).
ALTER TABLE plg_omadia_agent_facilitator_sessions ADD COLUMN IF NOT EXISTS conversation_id text;
ALTER TABLE plg_omadia_agent_facilitator_sessions ADD COLUMN IF NOT EXISTS linked_by text;
ALTER TABLE plg_omadia_agent_facilitator_sessions ADD COLUMN IF NOT EXISTS linked_at timestamptz;
-- Where the reading of the session conversation stands (its own cursor: it
-- is read through its own subscription).
ALTER TABLE plg_omadia_agent_facilitator_sessions ADD COLUMN IF NOT EXISTS inbound_cursor text;
-- The last readiness check of the session conversation: NULL not checked,
-- otherwise 'ready' or 'not_ready' with what is missing (criterion 60).
ALTER TABLE plg_omadia_agent_facilitator_sessions ADD COLUMN IF NOT EXISTS readiness text;
ALTER TABLE plg_omadia_agent_facilitator_sessions ADD COLUMN IF NOT EXISTS readiness_detail text;
ALTER TABLE plg_omadia_agent_facilitator_sessions DROP CONSTRAINT IF EXISTS plg_omadia_agent_facilitator_sessions_readiness_check;
ALTER TABLE plg_omadia_agent_facilitator_sessions
  ADD CONSTRAINT plg_omadia_agent_facilitator_sessions_readiness_check CHECK (readiness IS NULL OR readiness IN ('ready', 'not_ready'));
-- A conversation is the session conversation of at most one session of a
-- facilitation.
CREATE UNIQUE INDEX IF NOT EXISTS plg_omadia_agent_facilitator_sessions_conversation
  ON plg_omadia_agent_facilitator_sessions (facilitation_id, conversation_id) WHERE conversation_id IS NOT NULL;

-- People of a session conversation who are not home participants: they see
-- the session agenda, what is posted there and the session summary, never
-- the home conversation's history or protocol (5.3, 5.8). A home
-- participant who writes there is not listed here.
CREATE TABLE IF NOT EXISTS plg_omadia_agent_facilitator_session_participants (
  facilitation_id uuid NOT NULL REFERENCES plg_omadia_agent_facilitator_facilitations (id) ON DELETE CASCADE,
  session_id      uuid NOT NULL REFERENCES plg_omadia_agent_facilitator_sessions (id) ON DELETE CASCADE,
  principal_id    text NOT NULL,
  display_name    text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
  joined_at       timestamptz NOT NULL,
  left_at         timestamptz,
  PRIMARY KEY (session_id, principal_id)
);
CREATE INDEX IF NOT EXISTS plg_omadia_agent_facilitator_session_participants_by_person
  ON plg_omadia_agent_facilitator_session_participants (facilitation_id, principal_id);

-- What was said in a live session, one row per revision of a transcript
-- segment (5.3, criterion 62). `source` 'participant': a media channel bound
-- to one participant's account, `author_principal` is that person and the
-- segment counts after they confirm exactly this revision. 'shared': a room
-- microphone or mixed stream, no author; a participant may adopt exactly
-- this revision as their own contribution ("adopted from the transcript").
-- The speaker recognition is kept as a hint only and never sets authorship.
CREATE TABLE IF NOT EXISTS plg_omadia_agent_facilitator_transcript_segments (
  facilitation_id  uuid NOT NULL REFERENCES plg_omadia_agent_facilitator_facilitations (id) ON DELETE CASCADE,
  session_id       uuid REFERENCES plg_omadia_agent_facilitator_sessions (id) ON DELETE CASCADE,
  segment_id       text NOT NULL,
  revision         integer NOT NULL,
  event_id         text NOT NULL,
  source           text NOT NULL CHECK (source IN ('participant', 'shared')),
  author_principal text,
  speaker_hint     text,
  text             text NOT NULL,
  -- The facilitator's post that shows the segment (a reply to it adopts it).
  post_message_id  text,
  received_at      timestamptz NOT NULL,
  PRIMARY KEY (facilitation_id, segment_id, revision),
  CHECK ((source = 'participant') = (author_principal IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS plg_omadia_agent_facilitator_transcript_segments_by_post
  ON plg_omadia_agent_facilitator_transcript_segments (facilitation_id, post_message_id) WHERE post_message_id IS NOT NULL;

-- The message a session summary went out as: a reply to it is a consent
-- answer to exactly that summary (5.7).
ALTER TABLE plg_omadia_agent_facilitator_closings ADD COLUMN IF NOT EXISTS message_id text;
