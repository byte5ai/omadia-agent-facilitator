# omadia Facilitator (`@omadia/agent-facilitator`)

The facilitation engine for native facilitators
([byte5ai/omadia#2043](https://github.com/byte5ai/omadia/issues/2043)).

A facilitator is a kind of agent the kernel owns: its identity, the neutrality
block in its prompt, its own channel identity, the stored inbound messages and
the model turn. Everything a facilitation is made of lives in this plugin: the
data model and its migrations, the lifecycle, contributions, decision methods,
the scheduler and outbox, the process, transparency, visibility, retention,
quotas, sessions and the facilitations view.

## Requirements

| What | Version |
|---|---|
| omadia kernel | with `@omadia/plugin-api` >= 1.55.0 (#2043 contracts) |
| Postgres | required; the plugin declares `permissions.sql` and the operator grants it |
| Channel | one that gives each facilitator its own identity and delivers every message of a moderated conversation (Teams first) |

Every kernel service is declared under `optional_requires` and resolved when it
is used. A missing service never stops activation; the affected feature says
what is missing.

## Development

```sh
npm install        # links @omadia/plugin-api from ../odoo-bot/middleware/packages/plugin-api
npm run typecheck
npm run build
npm test
```

`npm test` transpiles `tests/*.test.ts` with esbuild and runs them with
`node --test`. Tests that need Postgres run against the database named by
`FACILITATOR_TEST_DATABASE_URL`; without it the runner starts a throwaway
cluster when `initdb` and `pg_ctl` are on the PATH. With neither, those tests
are reported as skipped.

The version lives in `package.json` and `manifest.yaml`; bump both.
