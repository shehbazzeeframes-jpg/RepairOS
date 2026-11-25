# Agent Team & Workflow

Claude (main session) is the **Engineering Manager / Tech Lead**: it owns the plan, breaks sprints into tasks, assigns them to agents, reviews output, resolves conflicts, and reports to the product owner (you).

| Agent | File | Owns | Does not do |
|---|---|---|---|
| **product-analyst** | `.claude/agents/product-analyst.md` | User stories, acceptance criteria, edge cases, competitor checks | Code |
| **ux-designer** | `.claude/agents/ux-designer.md` | Screen specs and flows using Astryx components/templates, states (empty/loading/error), copy | Backend |
| **backend-engineer** | `.claude/agents/backend-engineer.md` | `apps/api`, `apps/worker`, `packages/db`, `packages/contracts` | UI |
| **frontend-engineer** | `.claude/agents/frontend-engineer.md` | `apps/web`, `packages/ui`, `packages/print` | DB schema |
| **integrations-engineer** | `.claude/agents/integrations-engineer.md` | Stripe, Twilio, Resend, R2, printing/barcodes, CSV import | Core domain logic |
| **devops-engineer** | `.claude/agents/devops-engineer.md` | Docker, CI/CD, environments, secrets, monitoring, backups | Features |
| **qa-engineer** | `.claude/agents/qa-engineer.md` | Test plans, Playwright E2E, tenant-isolation tests, bug reports | Fixing bugs (reports them) |
| **code-reviewer** | `.claude/agents/code-reviewer.md` | Review of every change for correctness, security, conventions | Writing features |

## How a feature flows
```
product-analyst → story + acceptance criteria
      ↓
ux-designer → screen spec (Astryx components, states)       ┐ in parallel
backend-engineer → contracts (Zod) → API + tests           ┘
      ↓
frontend-engineer → UI on the contracts
      ↓
qa-engineer → E2E + isolation tests  →  code-reviewer → merge
      ↓
Tech lead demo → product owner sign-off
```

## Working rules
- One task = one branch = one pull request (`feat/<area>-<short-name>`).
- Agents that work in parallel get separate git worktrees so they never overwrite each other.
- Contracts merge before the UI that depends on them.
- Any change to architecture rules or `docs/ARCHITECTURE.md` needs tech-lead approval.
- Product owner approves: sprint goals, the theme/brand look, pricing, anything customer-facing that changes scope.
