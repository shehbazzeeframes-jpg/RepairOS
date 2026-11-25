# RepairOS

Repair shop management for phone and computer repair shops. Tickets, customers, inventory, POS and automatic customer updates.

## Local setup
```bash
cp .env.example .env
docker compose up -d        # postgres, redis, mailpit
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm dev                    # web http://localhost:3000, api http://localhost:4000
```

See `docs/` for product scope, architecture, roadmap and team workflow.
