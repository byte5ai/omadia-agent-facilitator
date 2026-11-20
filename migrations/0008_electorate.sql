-- The known electorate (specification B 5.5, byte5ai/omadia#2061, criteria
-- 35 and 44).
--
-- Automatic completeness and consent decisions need a complete, current list
-- of participants from one of two sources, fixed when the facilitation
-- starts and never changed within it:
--
--   platform_roster  the channel's member list answered `complete` at start;
--                    it is queried again, bypassing every cache, before each
--                    automatic decision;
--   declared_list    the channel could not list every member: the initiator
--                    named the participants, a person named by anybody is
--                    added on their own confirmation, a person who posts is
--                    added, nobody is removed by others.
--
-- A participant row says how the person came on the list: `roster` (the
-- channel listed them), `declared` (the initiator named them), `named`
-- (somebody else named them and they confirmed), `posted` (they wrote in the
-- conversation), `joined` (the channel's membership event).

ALTER TABLE plg_omadia_agent_facilitator_facilitations
  ADD COLUMN IF NOT EXISTS electorate_source text NOT NULL DEFAULT 'platform_roster'
    CHECK (electorate_source IN ('platform_roster', 'declared_list'));

-- A facilitation that started before this version without a member list ran
-- on whoever wrote; one whose initiator named the participants ran on that
-- list (whether or not the channel could list everybody, which was not
-- stored): both are declared lists.
UPDATE plg_omadia_agent_facilitator_facilitations
   SET electorate_source = 'declared_list'
 WHERE (settings ->> 'openRoster' = 'true' OR settings ->> 'participantsNamed' = 'true')
   AND electorate_source <> 'declared_list';

ALTER TABLE plg_omadia_agent_facilitator_participants DROP CONSTRAINT IF EXISTS plg_omadia_agent_facilitator_participants_source_check;
ALTER TABLE plg_omadia_agent_facilitator_participants
  ADD CONSTRAINT plg_omadia_agent_facilitator_participants_source_check
  CHECK (source IN ('roster', 'declared', 'named', 'posted', 'joined'));
