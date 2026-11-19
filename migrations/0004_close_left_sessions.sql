-- One-time cleanup (1.1.2): until 1.1.1 the sessions of a facilitation that
-- ended stayed "running" (or "scheduled"). Only facilitations that have ended
-- are touched; a session ends when its facilitation did.
UPDATE plg_omadia_agent_facilitator_sessions s
   SET status = 'ended', ended_at = coalesce(s.ended_at, f.closed_at, now())
  FROM plg_omadia_agent_facilitator_facilitations f
 WHERE f.id = s.facilitation_id AND f.phase IN ('closed', 'aborted') AND s.status = 'running';

UPDATE plg_omadia_agent_facilitator_sessions s
   SET status = 'cancelled'
  FROM plg_omadia_agent_facilitator_facilitations f
 WHERE f.id = s.facilitation_id AND f.phase IN ('closed', 'aborted') AND s.status = 'scheduled';
