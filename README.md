# RepairOS

Repair shop management for phone and computer repair shops. Tickets, customers, inventory, POS and automatic customer updates.

## Local setup
```bash
cp .env.example .env
docker compose up -d        # postgres, redis
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm dev                    # web http://localhost:3000, api http://localhost:4000, worker
```

Emails (invites, password resets) go to `.outbox/` in development (no `RESEND_API_KEY`); read them at
`/dev/outbox` in the web app or `GET /api/dev/outbox`. Production requires `RESEND_API_KEY` and `EMAIL_FROM`.

See `docs/` for product scope, architecture, roadmap and team workflow.
