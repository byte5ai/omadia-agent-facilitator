-- Question cards the engine posted (1.1.0).
--
-- An answer to a card comes back through the client and may be forged. The
-- engine counts it only when it fits the card it sent: this is that card,
-- with the step, round and version it was posted for.
CREATE TABLE IF NOT EXISTS plg_omadia_agent_facilitator_cards (
  card_id          text PRIMARY KEY,
  facilitation_id  uuid NOT NULL REFERENCES plg_omadia_agent_facilitator_facilitations (id) ON DELETE CASCADE,
  -- The step the card belongs to; null for a questionnaire.
  step_id          uuid REFERENCES plg_omadia_agent_facilitator_steps (id) ON DELETE CASCADE,
  round            integer NOT NULL DEFAULT 1,
  purpose          text NOT NULL CHECK (purpose IN ('vote', 'ideas', 'questionnaire')),
  proposal_id      text NOT NULL,
  proposal_version integer NOT NULL,
  -- The card as it was sent (title, questions, options).
  card             jsonb NOT NULL,
  state            text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed', 'superseded')),
  -- The channel's id of the posted card, once the send returned.
  message_id       text,
  created_at       timestamptz NOT NULL,
  closed_at        timestamptz,
  UNIQUE (facilitation_id, proposal_id, proposal_version)
);
CREATE INDEX IF NOT EXISTS plg_omadia_agent_facilitator_cards_open ON plg_omadia_agent_facilitator_cards (facilitation_id) WHERE state = 'open';
