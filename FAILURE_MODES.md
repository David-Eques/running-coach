# Failure Modes

Bugs found during development and in production, with their fixes. Each entry:
what happened, root cause, fix, status. Honest log — entries are only added
when something actually broke, not when it was predicted to.

Format:
```
### [observed YYYY-MM-DD] Short title
What happened: ...
Root cause: ...
→ Fix: ...
→ Status: applied | watching | won't fix
```

### [observed 2026-05-12] ACWR inflated — 7-day window was actually 8 days
What happened: a synthetic "one run per day, 28 days, equal TRIMP" case (ACWR should be ~1.0) reported ACWR 1.14, and `weekly_loads` summed to less than `chronic_load_28d`.
Root cause: the acute window in `analyze.ts` filtered with `>= sevenDaysAgo` and had no upper bound, so a closed interval picked up the activity from *exactly* 7 days ago in addition to the seven within — 8 daily activities, not 7. The weekly buckets used `[start, end)`, a different convention, so they didn't partition the 28-day window: the activity at `now` fell through entirely.
→ Fix: all windows are now half-open `(lower, upper]` with one shared `now`. Acute = `> sevenDaysAgo`; weekly bucket = `t > weekStart && t <= weekEnd`. The four weekly loads now sum to `chronic_load_28d` exactly, and the most-recent weekly load equals `acute_load_7d`. No thresholds changed. Regression tests added (`keeps the 7-day acute window at exactly 7 days`, plus a partition-sum assertion).
→ Status: applied

### [observed 2026-05-12] "Returning from a layoff" flag never fired
What happened: feeding the model "no training for 3+ weeks, one easy run yesterday" did not set `three_consecutive_weeks_no_training`, so `suggest_next_workout` recommended a normal week instead of a half-volume reintroduction.
Root cause: `computeFlags` checked `weekly_loads.slice(-3).every(w => w === 0)` — that slice includes the *current* week, which by definition is non-zero in exactly the scenario the flag exists to catch.
→ Fix: check the three weeks *before* the current one (`weekly_loads.slice(0, 3)` of the 4-week window). Flag name and behaviour downstream (`agent/prompt.md`, `suggestNextWorkout`) unchanged.
→ Status: applied

### [observed 2026-05-12] Monotony exploded on a zero-variation week
What happened: "60 TRIMP every day for 28 days" produced `monotony: 60`, which tripped the `monotony > 2.5` recovery override, so a perfectly steady, ACWR-1.0 block got `swap_for_recovery` instead of `execute_as_planned`.
Root cause: `sd = stddev(dailyLoads) || 1` — when all seven daily loads are identical, SD is 0 and the `|| 1` fallback makes `monotony = mean`, a number in TRIMP units (tens to hundreds) where Foster's monotony is dimensionless and ~1–2.5.
→ Fix: `monotony = sd > 0 ? mean/sd : 1`. A week with literally zero day-to-day variation is a degenerate case real data never hits (there is always a rest day or a pace difference); we report the neutral 1.0 there rather than a spurious large value. Tradeoff: this *under*-reports monotony risk for a hypothetical truly-uniform week — accepted, because (a) it can't happen with real Strava data and (b) ACWR and the volume/HR flags still cover the genuine overtraining signal. Revisit if real data ever produces a near-zero-SD week.
→ Status: applied (tradeoff: watching)

### [observed 2026-05-15] /mcp pinned to 99.9% error rate by hung GET-SSE requests
What happened: the Cloudflare dashboard showed ~17k requests / ~17k errors over 24h on `running-coach.workers.dev`, sustained at ~0.5 req/s. Every error was `"The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response."` Tool calls (POST /mcp) still worked, so the agent was unaffected — the symptom was purely a flood of failing background requests.
Root cause: the Streamable HTTP transport defines `GET /mcp` (with `Accept: text/event-stream`) as the server→client SSE channel for server-initiated messages. Every Claude Code client that connects to the MCP opens that channel on startup. The transport is configured in stateless mode (`sessionIdGenerator: undefined`) because Workers have no persistent session state — but the SDK's `handleGetRequest` still happily returns a `ReadableStream` that never emits, regardless of mode. The Worker runtime kills the request after its wall-clock budget; the client immediately reconnects; loop. Multiplied by every active Claude Code session = the spike.
→ Fix: short-circuit non-POST methods on `/mcp` with a 405 + `Allow: POST` *before* constructing the MCP server. The MCP spec permits this for servers that don't implement server-initiated messages, which we don't. Also added `src/index.test.ts` covering GET→405, DELETE→405, POST without bearer→401, POST with wrong bearer→401, and POST with valid bearer + initialize→200 — the route layer previously had zero tests, which is what let this ship. Considered but rejected: moving to session mode with a Durable Object (over-engineered — we don't need server→client messages); bumping the SDK pin (the real fix belongs at our edge, not chasing SDK behavior). Worth filing upstream: in stateless mode the SDK should arguably 405 itself.
→ Status: applied

### [observed 2026-05-15] claude.ai custom-connector UI rejects header-authenticated MCP servers
What happened: trying to add the running-coach MCP via the claude.ai project's "Add custom connector" dialog. The dialog accepts only a name + URL + (optional) OAuth Client ID/Secret. No field for arbitrary headers. Pasting `Authorization: Bearer <token>` into the URL field of course failed validation.
Root cause: the UI is OAuth-flavored (or no-auth). Bearer-header MCP servers are a CLI-only pattern there.
→ Fix: added a `?token=<value>` query-param fallback to the `/mcp` auth gate in `src/index.ts`. The Worker accepts the token via either `Authorization: Bearer <token>` (preferred — header) or `?token=<token>` (URL fallback for the connector UI). Tradeoff: URLs land in more places (browser history, proxy logs, error pages) than headers do; the header path stays preferred for CLI usage. Better long-term fix: implement OAuth on the Worker so the dialog's OAuth path works natively. Not done — too much for the value at single-tenant scale.
→ Status: applied (tradeoff: watching)

### [observed 2026-05-15] PII leak: pushed local main (with personal-fork commits) to public template remote
What happened: this repo lives across two remotes — `template` (public; David-Eques/running-coach) and `origin` (private; David-Eques/running-coach-personal). After committing a worker bug fix locally, I ran `git push template main` to share the fix. But local `main` had also accumulated commits with the personal fork's data (filled `agent/plan.md`, week-1 history file, real KV namespace id). Those landed on the public template for ~2 minutes before the visibility flip back to private.
Root cause: bare `git push template main` with no log-review and no `--force-with-lease=<expected-sha>`. The dual-remote topology had been set up correctly, but the discipline for *what* to push where was implicit, not enforced. I assumed "push to template" would push only the new commit; it pushed the whole branch.
→ Fix: force-pushed `template/main` back to a clean state — branched from the prior good commit (`9b1516e`), cherry-picked just the safe `?token=` fix from the personal-tainted commit, force-pushed that to `template/main`. Repo set to private during cleanup. Codified the two-remote discipline in `CLAUDE.md` as a new section: always `git log template/main..HEAD --oneline` before any push to template; never push local main to template/main; always `--force-with-lease=<branch>:<sha>` on force pushes; never flip repo visibility without explicit user authorization.
→ Status: applied (residual risk: orphan commits accessible via SHA on GitHub until GC, ~90 days)

## What I'm explicitly not protecting against

- Strava API going down for a week. Manual planning that week, no big deal.
- The MCP server being compromised. Single-user, no PII beyond fitness data, blast radius is fine.
- Bad coaching advice causing injury. The system has escalation rules; I read every weekly summary; this isn't an autonomous medical device.
- Model regressions. If a future Claude generates worse plans, I'll pin the model version. Not preemptively engineering for it.
