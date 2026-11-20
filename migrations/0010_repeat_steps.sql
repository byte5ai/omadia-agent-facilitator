-- A rule change after a step closed (specification B 5.7; byte5ai/omadia#2062,
-- criterion 57).
--
-- A closed step is never re-opened. If an accepted change of the method
-- affects it, the change adds a new step linked to it (`repeats_step_id`)
-- with the new method and fresh contributions; the old step and its protocol
-- stay as they were. Results derived from the old step are marked
-- `pending_repeat` until the repeat closes; then they are `replaced` by its
-- outcome, or `void` where they no longer hold (their owners are told).

ALTER TABLE plg_omadia_agent_facilitator_steps
  ADD COLUMN IF NOT EXISTS repeats_step_id uuid REFERENCES plg_omadia_agent_facilitator_steps (id) ON DELETE SET NULL;

ALTER TABLE plg_omadia_agent_facilitator_decisions
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'valid'
    CHECK (status IN ('valid', 'pending_repeat', 'replaced', 'void'));
ALTER TABLE plg_omadia_agent_facilitator_decisions
  ADD COLUMN IF NOT EXISTS replaced_by uuid REFERENCES plg_omadia_agent_facilitator_decisions (id) ON DELETE SET NULL;

ALTER TABLE plg_omadia_agent_facilitator_action_items
  ADD COLUMN IF NOT EXISTS pending_repeat boolean NOT NULL DEFAULT false;
ALTER TABLE plg_omadia_agent_facilitator_action_items DROP CONSTRAINT IF EXISTS plg_omadia_agent_facilitator_action_items_status_check;
ALTER TABLE plg_omadia_agent_facilitator_action_items
  ADD CONSTRAINT plg_omadia_agent_facilitator_action_items_status_check
  CHECK (status IN ('proposed', 'confirmed', 'done', 'declined', 'void'));
