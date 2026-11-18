-- Facilitation engine, data model (byte5ai/omadia#2043, spec 5.1).
--
-- The twelve tables of the spec plus what the engine needs to keep its
-- promises: the inbound ledger (idempotency by event), scheduler jobs (leases),
-- proposals (consent decisions), acknowledgements (a person confirms in their
-- own message) and the audited operator access.
--
-- Applied by the kernel's plugin migration runner in ONE transaction under an
-- advisory lock; the ledger is plg_omadia_agent_facilitator_migrations.

CREATE TABLE facilitations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitator_agent     text NOT NULL,
  channel_type          text NOT NULL,
  conversation_id       text NOT NULL,
  tenant_id             text,
  -- Kernel-stated principal of the person who asked the facilitator to start.
  initiator_principal   text NOT NULL,
  -- The initiator's participant row, once the two identities are matched.
  initiator_participant text,
  goal                  text NOT NULL,
  format                text NOT NULL,
  phase                 text NOT NULL DEFAULT 'configuring'
    CHECK (phase IN ('configuring', 'active', 'concluding', 'closed', 'aborted')),
  -- Bumped by every contribution, phase and rule change. A send that was
  -- computed against an older version is not delivered.
  state_version         integer NOT NULL DEFAULT 0,
  language              text NOT NULL DEFAULT 'de',
  deadline              timestamptz,
  timezone              text NOT NULL,
  close_rule            text NOT NULL DEFAULT 'all_contributed'
    CHECK (close_rule IN ('all_contributed', 'at_deadline')),
  reminder_policy       jsonb NOT NULL DEFAULT '{}'::jsonb,
  followup_policy       jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings              jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Last kernel event id the inbound consumer finished; the replay cursor.
  inbound_cursor        text,
  messages_sent         integer NOT NULL DEFAULT 0,
  quota_notice_sent     boolean NOT NULL DEFAULT false,
  result                jsonb,
  followup_state        text NOT NULL DEFAULT 'none'
    CHECK (followup_state IN ('none', 'active', 'ended')),
  followup_ends_at      timestamptz,
  created_at            timestamptz NOT NULL,
  activated_at          timestamptz,
  concluded_at          timestamptz,
  closed_at             timestamptz,
  close_reason          text,
  purge_after           timestamptz
);

-- One active facilitation per conversation.
CREATE UNIQUE INDEX facilitations_one_active_per_conversation
  ON facilitations (channel_type, conversation_id)
  WHERE phase IN ('configuring', 'active', 'concluding');
CREATE INDEX facilitations_by_facilitator ON facilitations (facilitator_agent, phase);
CREATE INDEX facilitations_by_conversation ON facilitations (channel_type, conversation_id, created_at DESC);
CREATE INDEX facilitations_purge ON facilitations (purge_after) WHERE purge_after IS NOT NULL;

CREATE TABLE facilitation_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitation_id     uuid NOT NULL REFERENCES facilitations (id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('async', 'live')),
  title               text,
  scheduled_start     timestamptz,
  scheduled_end       timestamptz,
  meeting_ref         text,
  modality            text NOT NULL DEFAULT 'chat' CHECK (modality IN ('chat', 'online', 'hybrid')),
  capability_snapshot jsonb,
  -- Processing of a call's audio or video: announced, nobody objected.
  media_consent       text NOT NULL DEFAULT 'not_needed'
    CHECK (media_consent IN ('not_needed', 'pending', 'granted', 'refused', 'withdrawn')),
  status              text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'running', 'ended', 'cancelled')),
  agenda_sent_at      timestamptz,
  started_at          timestamptz,
  ended_at            timestamptz,
  created_at          timestamptz NOT NULL
);
CREATE INDEX facilitation_sessions_by_facilitation ON facilitation_sessions (facilitation_id, status);

CREATE TABLE facilitation_stakeholders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitation_id uuid NOT NULL REFERENCES facilitations (id) ON DELETE CASCADE,
  principal       text,
  address         text,
  display_name    text,
  role            text NOT NULL CHECK (role IN ('receives_protocol', 'invited_to_followups')),
  added_by        text NOT NULL,
  confirmed       boolean NOT NULL DEFAULT false,
  confirmed_at    timestamptz,
  created_at      timestamptz NOT NULL,
  CHECK (principal IS NOT NULL OR address IS NOT NULL)
);
CREATE INDEX facilitation_stakeholders_by_facilitation ON facilitation_stakeholders (facilitation_id);

-- The agenda.
CREATE TABLE facilitation_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitation_id uuid NOT NULL REFERENCES facilitations (id) ON DELETE CASCADE,
  position        integer NOT NULL,
  kind            text NOT NULL
    CHECK (kind IN ('open', 'collect', 'discuss', 'cluster', 'prioritise', 'decide', 'assign', 'close')),
  title           text NOT NULL,
  timebox_minutes integer,
  method          text CHECK (method IN ('ranked', 'single', 'approval', 'consent', 'assignment')),
  -- The options (or items to assign) of the step: [{ "key": "A", "label": "..." }].
  options         jsonb NOT NULL DEFAULT '[]'::jsonb,
  method_config   jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'open', 'closed')),
  -- 1 for the first vote; a runoff after a tie is the next round of the same step.
  round           integer NOT NULL DEFAULT 1,
  round_options   jsonb,
  round_deadline  timestamptz,
  opened_at       timestamptz,
  timebox_ends_at timestamptz,
  closed_at       timestamptz,
  UNIQUE (facilitation_id, position)
);

CREATE TABLE facilitation_participants (
  facilitation_id     uuid NOT NULL REFERENCES facilitations (id) ON DELETE CASCADE,
  -- Authenticated channel user id, as the kernel event states it.
  principal_id        text NOT NULL,
  -- Canonical principal ('user:<id>') once an event carried it.
  canonical_principal text,
  display_name        text NOT NULL,
  email               text,
  source              text NOT NULL CHECK (source IN ('roster', 'joined')),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
  joined_at           timestamptz NOT NULL,
  left_at             timestamptz,
  changed_at          timestamptz NOT NULL,
  changed_by_event    text,
  PRIMARY KEY (facilitation_id, principal_id)
);

CREATE TABLE facilitation_dod_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitation_id     uuid NOT NULL REFERENCES facilitations (id) ON DELETE CASCADE,
  version             integer NOT NULL,
  text                text NOT NULL,
  -- Machine-checkable criteria; NULL means free text, confirmed by the group.
  criteria            jsonb,
  proposed_by         text NOT NULL,
  proposal_message_id text,
  consent_state       text NOT NULL DEFAULT 'initial'
    CHECK (consent_state IN ('initial', 'proposed', 'accepted', 'rejected')),
  effective_at        timestamptz,
  created_at          timestamptz NOT NULL,
  UNIQUE (facilitation_id, version)
);

CREATE TABLE facilitation_contributions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitation_id       uuid NOT NULL REFERENCES facilitations (id) ON DELETE CASCADE,
  step_id               uuid NOT NULL REFERENCES facilitation_steps (id) ON DELETE CASCADE,
  round                 integer NOT NULL DEFAULT 1,
  participant_principal text NOT NULL,
  kind                  text NOT NULL
    CHECK (kind IN ('idea', 'position', 'concern', 'question', 'proposal', 'vote',
                    'confirmation', 'objection', 'abstention', 'commitment')),
  payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Everything below is copied from the kernel's stored event, never from a
  -- tool argument. NULL only for a spoken contribution, which stays
  -- unconfirmed until its owner confirms it in an authenticated input.
  source                text NOT NULL DEFAULT 'message'
    CHECK (source IN ('message', 'card', 'speech')),
  source_message_id     text,
  source_revision       integer,
  source_event_id       text,
  source_occurred_at    timestamptz,
  -- 'unconfirmed': interpreted from free text or speech, waits for its author.
  status                text NOT NULL
    CHECK (status IN ('valid', 'unconfirmed', 'ambiguous', 'superseded', 'withdrawn')),
  interpreted           boolean NOT NULL DEFAULT false,
  recorded_at           timestamptz NOT NULL,
  CHECK (source = 'speech' OR source_message_id IS NOT NULL)
);
-- A message is the source of at most one live contribution per facilitation.
CREATE UNIQUE INDEX facilitation_contributions_source_unique
  ON facilitation_contributions (facilitation_id, source_message_id)
  WHERE status IN ('valid', 'unconfirmed', 'ambiguous');
CREATE INDEX facilitation_contributions_by_step
  ON facilitation_contributions (step_id, round, participant_principal, status);

CREATE TABLE facilitation_clusters (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitation_id         uuid NOT NULL REFERENCES facilitations (id) ON DELETE CASCADE,
  step_id                 uuid NOT NULL REFERENCES facilitation_steps (id) ON DELETE CASCADE,
  label                   text NOT NULL,
  member_contribution_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposed_by_facilitator boolean NOT NULL DEFAULT true,
  confirmed               boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL
);
CREATE INDEX facilitation_clusters_by_step ON facilitation_clusters (step_id);

CREATE TABLE facilitation_decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitation_id uuid NOT NULL REFERENCES facilitations (id) ON DELETE CASCADE,
  step_id         uuid REFERENCES facilitation_steps (id) ON DELETE SET NULL,
  statement       text NOT NULL,
  method          text NOT NULL,
  result          jsonb NOT NULL DEFAULT '{}'::jsonb,
  rationale       text,
  decided_at      timestamptz NOT NULL
);
CREATE INDEX facilitation_decisions_by_facilitation ON facilitation_decisions (facilitation_id);

CREATE TABLE facilitation_action_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitation_id uuid NOT NULL REFERENCES facilitations (id) ON DELETE CASCADE,
  decision_id     uuid REFERENCES facilitation_decisions (id) ON DELETE SET NULL,
  number          integer NOT NULL,
  description     text NOT NULL,
  owner_principal text NOT NULL,
  -- An action item binds only when its owner confirmed in their own message.
  owner_confirmed boolean NOT NULL DEFAULT false,
  due_date        timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'confirmed', 'done', 'declined')),
  reminders_sent  integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL,
  confirmed_at    timestamptz,
  done_at         timestamptz,
  UNIQUE (facilitation_id, number)
);

-- Append-only protocol: posts, reminders, changes, decisions, reports, every
-- use of a scoped capability.
CREATE TABLE facilitation_events (
  id              bigserial PRIMARY KEY,
  facilitation_id uuid NOT NULL REFERENCES facilitations (id) ON DELETE CASCADE,
  kind            text NOT NULL,
  actor           text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL
);
CREATE INDEX facilitation_events_by_facilitation ON facilitation_events (facilitation_id, id);

CREATE FUNCTION facilitation_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'facilitation_events is append-only';
END;
$$;
-- Rows go away only with their facilitation (retention); they never change.
CREATE TRIGGER facilitation_events_no_update
  BEFORE UPDATE ON facilitation_events
  FOR EACH ROW EXECUTE FUNCTION facilitation_events_append_only();

-- Every channel send is recorded here before the call.
CREATE TABLE facilitation_outbox (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Delivery order: messages of one facilitation go out as they were queued.
  seq                    bigserial NOT NULL,
  facilitation_id        uuid NOT NULL REFERENCES facilitations (id) ON DELETE CASCADE,
  idempotency_key        text NOT NULL UNIQUE,
  purpose                text NOT NULL,
  target_kind            text NOT NULL CHECK (target_kind IN ('group', 'direct')),
  target_principal       text,
  payload                jsonb NOT NULL,
  -- essential: at-least-once (handshake, result, abort report).
  -- droppable: at-most-once (reminders, echoes, moderation posts).
  delivery_class         text NOT NULL CHECK (delivery_class IN ('essential', 'droppable')),
  required_phases        jsonb,
  required_state_version integer,
  status                 text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'dropped', 'failed')),
  attempts               integer NOT NULL DEFAULT 0,
  next_attempt_at        timestamptz,
  -- The engine instance that enqueued or last attempted the row.
  owner                  text NOT NULL,
  last_error             text,
  drop_reason            text,
  channel_message_id     text,
  created_at             timestamptz NOT NULL,
  sent_at                timestamptz,
  CHECK (target_kind = 'group' OR target_principal IS NOT NULL)
);
CREATE INDEX facilitation_outbox_pending ON facilitation_outbox (facilitation_id, seq)
  WHERE status IN ('pending', 'sending');

-- Inbound ledger: an event is processed once, whatever the kernel redelivers.
CREATE TABLE facilitation_inbound (
  facilitation_id  uuid NOT NULL REFERENCES facilitations (id) ON DELETE CASCADE,
  event_id         text NOT NULL,
  message_id       text NOT NULL,
  revision         integer NOT NULL,
  kind             text NOT NULL,
  author_principal text NOT NULL,
  outcome          text NOT NULL,
  processed_at     timestamptz NOT NULL,
  PRIMARY KEY (facilitation_id, event_id)
);
CREATE INDEX facilitation_inbound_by_message ON facilitation_inbound (facilitation_id, message_id, revision);

-- Time-based work. A job runs under a lease, so two replicas never both fire it.
CREATE TABLE facilitation_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitation_id uuid NOT NULL REFERENCES facilitations (id) ON DELETE CASCADE,
  kind            text NOT NULL,
  dedupe_key      text NOT NULL UNIQUE,
  due_at          timestamptz NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'cancelled', 'failed')),
  lease_owner     text,
  lease_until     timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL,
  finished_at     timestamptz
);
CREATE INDEX facilitation_jobs_due ON facilitation_jobs (due_at) WHERE status = 'pending';
CREATE INDEX facilitation_jobs_by_facilitation ON facilitation_jobs (facilitation_id, status);

-- A consent decision the facilitator puts to the group: rule changes, clusters,
-- summaries, closing a step, the binding close.
CREATE TABLE facilitation_proposals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitation_id     uuid NOT NULL REFERENCES facilitations (id) ON DELETE CASCADE,
  kind                text NOT NULL,
  summary             text NOT NULL,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_by         text NOT NULL,
  proposal_message_id text,
  announce_message_id text,
  status              text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'accepted', 'rejected', 'withdrawn')),
  window_ends_at      timestamptz NOT NULL,
  consents            jsonb NOT NULL DEFAULT '[]'::jsonb,
  objections          jsonb NOT NULL DEFAULT '[]'::jsonb,
  opened_at           timestamptz NOT NULL,
  decided_at          timestamptz
);
-- One open proposal at a time, so "agreed" and "objection" are never ambiguous.
CREATE UNIQUE INDEX facilitation_proposals_one_open
  ON facilitation_proposals (facilitation_id) WHERE status = 'open';

-- Something one person has to confirm in their own message: the echo of a
-- contribution read from free text, a nomination, an action item.
CREATE TABLE facilitation_acks (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitation_id        uuid NOT NULL REFERENCES facilitations (id) ON DELETE CASCADE,
  principal              text NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('contribution', 'nomination', 'action_item')),
  ref_id                 uuid NOT NULL,
  detail                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt_message_id      text,
  status                 text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'declined', 'cancelled')),
  created_at             timestamptz NOT NULL,
  resolved_at            timestamptz,
  resolved_by_message_id text
);
CREATE INDEX facilitation_acks_pending ON facilitation_acks (facilitation_id, principal) WHERE status = 'pending';

-- Operator access to contents, and operator terminations. No foreign key:
-- the audit outlives the facilitation it is about.
CREATE TABLE facilitation_access_audit (
  id              bigserial PRIMARY KEY,
  facilitation_id uuid NOT NULL,
  action          text NOT NULL CHECK (action IN ('content_read', 'terminate')),
  actor           text NOT NULL,
  reason          text NOT NULL,
  occurred_at     timestamptz NOT NULL
);
CREATE INDEX facilitation_access_audit_by_facilitation ON facilitation_access_audit (facilitation_id, id);
