# HANDOFF

Status snapshot for whoever (Claude Code, future me) picks this up next.

## State as of 2026-05-12 — Phase 1 done (the parts that don't need David's accounts)

**The Worker builds, typechecks, tests green, and serves the MCP locally.** What's been done:

- `@modelcontextprotocol/sdk` pinned to **`1.29.0`**. `npm install` works (one gotcha — see "Known gotchas").
- Transport reconciled: switched from the Node-HTTP `StreamableHTTPServerTransport` to the Web-Standards `WebStandardStreamableHTTPServerTransport` (Fetch `Request`/`Response`, which is what a Worker actually has), stateless mode. `src/index.ts` tool registrations and shapes unchanged.
- `npm run typecheck` (new `tsc --noEmit` script — `typescript` is now a devDep) is clean. `src/` has no `any` left; `strava.ts`/`index.ts` use typed Strava response shapes.
- `npm test` — 9/9 green. Three real bugs in `analyze.ts` were found and fixed (acute-window off-by-one, the layoff flag never firing, monotony exploding on a zero-variance week); all logged in `FAILURE_MODES.md` under "Observed failures", regression tests added. No thresholds changed.
- `ATHLETE_LTHR` is now a `wrangler.toml [vars]` value (default 170) instead of a hardcoded constant, with plausibility validation in `src/index.ts`.
- `wrangler dev` verified: `POST /mcp` + bearer + bad body → JSON-RPC parse error; `tools/list` → all three tools; no bearer → 401.

**Not yet done — needs David's accounts/credentials:** Cloudflare KV namespace + secrets + `wrangler deploy` (SETUP steps 3–5), the one-time Strava OAuth bootstrap (step 6), wiring the deployed MCP into Claude Code (step 7), and everything downstream that needs real Strava data or the real training plan (`agent/plan.md` is still a template; Phase 2 step 7).

A throwaway `.dev.vars` (gitignored) with placeholder secrets exists so `wrangler dev` can start — replace/delete at will; production uses `wrangler secret put`.

## What exists

Repo layout:

```
running-coach/
├── README.md                 # public pitch
├── ARCHITECTURE.md           # design doc, FDE signal #1
├── PROMPT_DESIGN.md          # LLM engineering log, FDE signal #2
├── FAILURE_MODES.md          # operational thinking, FDE signal #3
├── SETUP.md                  # deployment steps
├── CLAUDE.md                 # conventions for Claude Code
├── HANDOFF.md                # ← this file
├── package.json
├── wrangler.toml
├── tsconfig.json
├── .gitignore
├── .env.example
├── LICENSE
├── src/
│   ├── index.ts              # Hono + MCP wiring, 3 tool registrations, OAuth bootstrap route
│   ├── strava.ts             # Strava client w/ token refresh, activity normalization
│   ├── analyze.ts            # load math, decision rules (deterministic, testable)
│   └── analyze.test.ts       # baseline tests for the load model
└── agent/
    ├── prompt.md             # the weekly scheduled-task prompt
    ├── plan.md               # athlete plan template (needs to be filled in)
    └── kot.md                # KOT strength menu
```

## Priority-ordered next tasks

### Phase 1 — Make it build and deploy

1. ~~`npm install`, pin the SDK version.~~ **Done** — pinned `@modelcontextprotocol/sdk@1.29.0`.
2. ~~Verify `src/index.ts` imports against the installed SDK.~~ **Done** — `McpServer` import unchanged; the transport moved to `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` (Fetch-native; stateless). Structure (Hono → `/mcp` → connect transport → server with three tools) unchanged.
3. ~~`npm test`.~~ **Done** — 9/9 green. Three `analyze.ts` bugs found + fixed (see `FAILURE_MODES.md`), regression tests added, no thresholds touched. Also added `npm run typecheck` / `npm run check`; both clean.
4. ~~`wrangler dev` "server is alive" check.~~ **Done** — `POST /mcp` + bearer + bad body → JSON-RPC parse error; `tools/list` → three tools; no bearer → 401.
5. **Walk `SETUP.md` steps 3–6 — needs David.** Cloudflare login, KV namespace (paste the id into `wrangler.toml`, currently `REPLACE_WITH_KV_ID`), `wrangler secret put` ×3, `wrangler deploy`, then the one-time Strava OAuth bootstrap. Without the bootstrap no tool call returns data.

### Phase 2 — Make it useful (week 1)

6. From a Claude Code session, connect to the deployed MCP using the bearer token. Call `analyze_training_load(weeks=4)` manually. The response should contain non-zero numbers for someone with recent Strava activity. If `data_quality.coverage_pct` is low, check Strava for missing HR data.
7. Fill in `agent/plan.md` with David's real plan (race goal, dates, week-by-week skeleton). This requires answers from him; do not invent. (Open questions below.)
8. Set `ATHLETE_LTHR` in `wrangler.toml` `[vars]` (currently `"170"`) to David's actual lactate-threshold HR — or `wrangler deploy --var ATHLETE_LTHR:<n>`. If unknown, estimate as `0.89 × max_hr` and note the estimate in the commit message. Keep it in sync with `agent/plan.md`.
9. Run `agent/prompt.md` manually in a Claude Code session every evening for 3-4 days. Don't schedule it yet. Read each output. Log surprises in `FAILURE_MODES.md` under "Observed failures."

### Phase 3 — Automate (week 2)

10. Once 3 consecutive manual runs produce plans David trusts without edits, schedule the task at `claude.ai/code/scheduled`. Weekly, Sunday 8pm local.
11. Monitor the first 2 scheduled runs. Compare against what the manual runs produced.
12. If the scheduled task drifts from the manual runs, the prompt is leaking context that depended on the chat history. Tighten `agent/prompt.md` until the scheduled output matches what a fresh manual session produces.

### Phase 4 — Publish (week 3)

13. Draft the retrospective blog post. Source material: pull the architecture diagram from `ARCHITECTURE.md`, the iteration log from `PROMPT_DESIGN.md`, real failures from `FAILURE_MODES.md`.
14. Tighten the README for public visibility. Make sure no secrets, no personal data leak through example outputs.
15. Push to a public repo.

## Open questions (need David's input)

- Race goal, date, target time for `agent/plan.md`
- Current weekly mileage and comfortable easy pace
- Lactate threshold HR (or max HR for estimation)
- Injuries / KOT progression starting points
- Confirm KOT placement: Tue/Thu vs. another split

Without these, `agent/plan.md` stays a template. Phase 2 can begin but Phase 2 step 7 blocks here.

## Known gotchas

- **SDK churn.** The MCP SDK moves fast. Pinned to `1.29.0`. If you bump it, re-check the transport surface (`WebStandardStreamableHTTPServerTransport`, `McpServer.tool` — the `tool()` overload is `@deprecated` in favour of `registerTool` but still works) and `npm run typecheck` after.
- **`npm install` skips workerd's platform binary.** `npm install` sometimes doesn't pull `@cloudflare/workerd-darwin-arm64` (or your platform's equivalent) — a known npm optional-deps bug — and then `wrangler dev` crashes. Re-run `npm install`, or `npm install @cloudflare/workerd-darwin-arm64`, or nuke `node_modules` + lockfile and reinstall. The committed `package-lock.json` should prevent it.
- **Worker compatibility flags.** `nodejs_compat` is set in `wrangler.toml`. The SDK uses Node-flavored APIs in places.
- **Timezone.** Strava timestamps UTC; calendar events need local. The prompt handles conversion but verify on the first real run.
- **Activity type filter.** `src/strava.ts` filters to `Run`, `TrailRun`, `VirtualRun`. Treadmill is `Run` in Strava if recorded as such; trail-on-Strava is `TrailRun`. Cross-training won't be analyzed. By design.
- **Monotony on a zero-variance week.** Reports the neutral `1.0` rather than a spurious large value (real data never hits SD=0). Slightly under-reports monotony risk in that one degenerate case — see `FAILURE_MODES.md`.
- **Single-user assumption everywhere.** KV key is `tokens` (no namespacing); `ATHLETE_LTHR` is a deployment var. If you ever multi-tenant this, all of `src/` needs rework.

## Definition of done for this handoff

David should be able to:

1. `cd running-coach && claude` and have Claude Code immediately know the project.
2. Follow `SETUP.md` and have a deployed, working MCP within an hour.
3. Run the agent prompt and get a real plan written to his calendar.

If any of those three things is not true at the end of Phase 2, something in this handoff failed and should be patched in the docs, not learned twice.
