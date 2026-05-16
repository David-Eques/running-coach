# CLAUDE.md

This file is the entry point for Claude Code working in this repo. Read it first. Then `README.md` for what the project is and how to deploy it, and `ARCHITECTURE.md` for the design decisions you'll need to respect.

## What this is

A Cloudflare Workers MCP server exposing **coaching-shaped tools** (`get_recent_training`, `analyze_training_load`, `suggest_next_workout`) backed by Strava, plus a Claude Code scheduled task that uses them to generate weekly run plans into Google Calendar.

This is a **reference implementation** intended as an FDE portfolio piece. Code quality, documentation quality, and design clarity all matter. It is not a hackathon prototype. Write code that reads like it was written by someone who intends to ship and maintain it.

## Architectural commitments (do not change without discussion)

These decisions are load-bearing for the project's value as a reference. Don't relitigate them silently.

1. **Tools are coaching-shaped, not API-shaped.** No tool named `get_activities` or `get_athlete`. If you find yourself wanting to add one, the answer is to extend an existing coaching tool or add a new coaching verb (e.g. `analyze_taper_readiness`).
2. **Load math lives in `src/analyze.ts`, not in prompts.** ACWR, TRIMP, monotony, decision thresholds — all in versioned code. The LLM applies the rules; it does not invent them.
3. **Single user, single tenant.** Auth is a static bearer token. Do not introduce multi-tenancy, per-user OAuth, or a database. If multi-tenant becomes the goal, that's a separate project.
4. **Reads only.** This system never writes to Strava. Calendar writes happen through Google Calendar connector at the agent layer, never through the MCP.
5. **The four writeups are first-class artifacts.** `ARCHITECTURE.md`, `PROMPT_DESIGN.md`, `FAILURE_MODES.md`, and `README.md` are the FDE signal. Code changes that affect any of them should include the doc update in the same change.

## File ownership

| File | Owner | Edit rules |
|---|---|---|
| `agent/plan.md` | David (athlete config) | Don't edit. If a change is needed, surface it. |
| `agent/kot.md` | David | Same. |
| `agent/prompt.md` | Shared, careful | Updates must be reflected in `PROMPT_DESIGN.md` iteration log. |
| `src/analyze.ts` | Shared, careful | Threshold/formula changes need a citation in the references block. |
| `ARCHITECTURE.md` | Shared | Update when you make a structural decision. |
| `FAILURE_MODES.md` | Shared, append-only | Add observed failures with `[observed YYYY-MM-DD]`. Don't delete predicted ones that turned out wrong — mark them resolved. |
| `README.md` | Shared | Keep the architecture diagram in sync with reality. |

## Stack

- Cloudflare Workers, TypeScript, Hono router.
- `@modelcontextprotocol/sdk` for MCP server + Streamable HTTP transport.
- Zod for tool input schemas.
- Vitest for tests.
- Workers KV for the Strava token bundle.

The SDK moves fast. Pinned to `@modelcontextprotocol/sdk@1.29.0`. `src/index.ts` uses `WebStandardStreamableHTTPServerTransport` (Fetch-native; the Node-HTTP `StreamableHTTPServerTransport` does not work on Workers) in stateless mode. If you bump the SDK, re-verify the transport surface and run `npm run typecheck`.

## Develop / deploy

```bash
npm install
npm run typecheck             # tsc --noEmit (strict)
npm test                      # vitest run — unit tests for analyze.ts
npm run check                 # typecheck + test, in one shot
wrangler dev                  # local
wrangler deploy               # production
```

Wrangler secrets needed (`wrangler secret put NAME`):
- `STRAVA_CLIENT_ID`
- `STRAVA_CLIENT_SECRET`
- `MCP_BEARER_TOKEN`

KV namespace `STRAVA_TOKENS` must exist (see SETUP.md step 3).

## Conventions

- TypeScript strict on. No `any` in checked-in code (errors thrown with structured messages).
- Tool descriptions in `src/index.ts` are read by the LLM — write them for the LLM, not for a human dev. State *when* to call the tool, not just what it does.
- Numeric thresholds in `src/analyze.ts` are named constants where possible and cite a source.
- Tests for `analyze.ts` are mandatory if you change a formula. UI/integration tests are not expected.
- Commit messages use the form `<area>: <change>` (e.g. `analyze: tighten ACWR optimal upper bound to 1.25`).

## Things to never do without asking

- Add a tool that mirrors Strava's REST shape (`get_activities`, `get_segments`, etc.)
- Change ACWR / monotony / TRIMP thresholds in `analyze.ts`
- Introduce a database, ORM, or persistent storage beyond Workers KV
- Add multi-user OAuth or session management
- Wire any Strava write endpoint
- Generate calendar events directly from the MCP (that's the agent's job)
- Ship a code change that breaks an existing test
- Resolve a failure mode without adding an entry to `FAILURE_MODES.md`
- Change the visibility of any GitHub repo (private ↔ public). Visibility is the user's call; you ask, you don't decide.
- Disclose secrets or PII because you judged the risk "marginal." The user's standard is theirs to set, not yours.

## Two-remote git discipline (PII guard)

This project has **two remotes** with very different rules:

- `origin` → `David-Eques/running-coach-personal` (private) — has the athlete's filled `agent/plan.md`, real KV id, accumulated `agent/history/*.md`. Safe to push freely.
- `template` → `David-Eques/running-coach` (public) — must only contain the sanitized template. Filled plan, history files, real KV id are PII and must NEVER land here.

Mixing the two has already caused one incident (a `git push template main` pushed local main which had personal commits, briefly exposing PII; force-pushed a cherry-picked clean state to recover). To prevent a repeat, follow this protocol **every time** you push to `template/*`:

1. **Show the user the commit list that would land**, before any push:
   ```bash
   git fetch template
   git log template/main..HEAD --oneline
   ```
   Read every commit subject. If any commit subject contains "personal", touches `agent/plan.md` content, `agent/history/`, the real KV id, or anything PII-shaped — **stop**. Cherry-pick only the safe commits onto a clean base branched from `template/main`.

2. **Never push local `main` directly to `template/main`** if local `main` has commits beyond what `template/main` has. Always cherry-pick onto a temp branch built from `template/main`:
   ```bash
   git checkout -b template-fix template/main
   git cherry-pick <safe-sha>
   git push --force-with-lease=main:<expected-template-main-sha> template template-fix:main
   git checkout main && git branch -D template-fix
   ```

3. **Never use bare `--force`** on a public remote. Always `--force-with-lease=<branch>:<expected-sha>` so a race condition can't silently overwrite something you haven't seen.

4. **Never flip repo visibility without explicit user authorization** — this includes "back to public after I've cleaned up." Wait for the green light.

If any of these feel like friction in the moment, that's the point: the friction is cheaper than the leak.

## When in doubt

Look at the four writeups. If your proposed change isn't consistent with what they say, the change is wrong, the doc is wrong, or you've found something interesting — surface it instead of papering over.
