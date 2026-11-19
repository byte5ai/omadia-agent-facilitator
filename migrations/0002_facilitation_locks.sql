-- The lock of a facilitation as a row with a lease (1.0.5).
--
-- Until 1.0.4 it was a session-level advisory lock. Behind a pooler in
-- transaction mode a statement outside a transaction may run on any server
-- session: the lock was taken on one and "released" on another, and stayed
-- held until the first session ended. A row is the same for every session.
-- No foreign key: a lock id need not be a facilitation that still exists.
CREATE TABLE IF NOT EXISTS plg_omadia_agent_facilitator_locks (
  facilitation_id text PRIMARY KEY,
  owner           text NOT NULL,
  lease_until     timestamptz NOT NULL,
  acquired_at     timestamptz NOT NULL
);
