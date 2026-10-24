![Welcome to Santa Monica](santa-monica.jpg)

# Anonymous Ded Morozes

This is back-end side of the Anonymous Ded Morozes

- [Front Yard](https://github.com/uglyunicorn-eh/santa-barbara)
- [Backyard](https://github.com/uglyunicorn-eh/santa-monica)

## Development

The API is a Cloudflare Worker (Hono + Apollo Server) with its data in Durable Objects: one `PartyDO` per party and one `UserDO` per user. Mail goes through Cloudflare Email Service. See [docs/MIGRATION_PLAN.md](docs/MIGRATION_PLAN.md) for the design.

```bash
npm install
cp .dev.vars.example .dev.vars   # then set JWT_SECRET (and ADMIN_SECRET for imports)
npm run dev                      # http://localhost:8787, GraphQL at /graph
npm test
npm run typecheck
```

Deploy with `npm run deploy`. Production secrets are set with `npx wrangler secret put JWT_SECRET` (and `SENTRY_DSN`).
