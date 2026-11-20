-- Several contributions per message, and contributions imported on behalf of
-- somebody else (specification B 5.1, 5.3; byte5ai/omadia#2061, criterion 50).
--
-- One message may carry several contributions ("three ideas in one
-- message"); each is a part with its own index. A message is the source of at
-- most one live contribution per part: a repeated recording of the same
-- message creates nothing new, and a new revision supersedes every part of
-- the older one.
--
-- A contribution somebody records for another person (older votes from a
-- screenshot) is `pending_import` until that person confirms it in their own
-- message; the payload keeps who imported it and from where. The person's
-- confirmation is an acknowledgement of kind `import`.

ALTER TABLE plg_omadia_agent_facilitator_contributions
  ADD COLUMN IF NOT EXISTS part_index integer NOT NULL DEFAULT 0 CHECK (part_index >= 0);

ALTER TABLE plg_omadia_agent_facilitator_contributions DROP CONSTRAINT IF EXISTS plg_omadia_agent_facilitator_contributions_status_check;
ALTER TABLE plg_omadia_agent_facilitator_contributions
  ADD CONSTRAINT plg_omadia_agent_facilitator_contributions_status_check
  CHECK (status IN ('valid', 'unconfirmed', 'ambiguous', 'pending_import', 'superseded', 'withdrawn'));

DROP INDEX IF EXISTS plg_omadia_agent_facilitator_contributions_source_unique;
CREATE UNIQUE INDEX IF NOT EXISTS plg_omadia_agent_facilitator_contributions_source_part_unique
  ON plg_omadia_agent_facilitator_contributions (facilitation_id, source_message_id, part_index)
  WHERE status IN ('valid', 'unconfirmed', 'ambiguous', 'pending_import');

ALTER TABLE plg_omadia_agent_facilitator_acks DROP CONSTRAINT IF EXISTS plg_omadia_agent_facilitator_acks_kind_check;
ALTER TABLE plg_omadia_agent_facilitator_acks
  ADD CONSTRAINT plg_omadia_agent_facilitator_acks_kind_check
  CHECK (kind IN ('contribution', 'nomination', 'action_item', 'import'));
