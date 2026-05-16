# Failure Modes

A living log. Predictions made pre-deployment, marked `[predicted]`. Observed failures get added with date and `[observed]`. Resolved ones get a `→ fix` line.

The goal isn't a clean list — it's evidence that I thought about what could break before it broke, and learned when reality disagreed.

## Tool layer

### `[predicted]` Strava token refresh races
Two scheduled task invocations close together could both try to refresh the access token, with the second invalidating the first. Probability: low (weekly cadence), impact: low (one failed run, retry next week).
→ Mitigation: KV-based locking with TTL. Not implementing for v0.

### `[predicted]` Strava rate limits
100 req/15min, 1000/day. A long lookback (`weeks=12` × bulk activity detail fetches) could blow through. Probability: low at current scope, impact: medium (incomplete analysis).
→ Mitigation: cap `analyze_training_load` lookback at 12 weeks. Cache aggregated weekly summaries in KV with 24h TTL so repeated calls within a day are cheap.

### `[predicted]` Missing HR data
Strava activities without HR break TRIMP calculation. Some users only track GPS. Probability: high (some of my own runs are forgot-the-strap), impact: medium (skewed load if many missing).
→ Mitigation: fall back to RPE-estimated TRIMP using duration and an assumed intensity factor based on activity type. Mark the estimate explicitly in the response so the agent knows it's lower confidence.

### `[predicted]` Activity type drift
"Run" includes treadmill, trail, race, virtual, fartlek. They're not equal stimuli. Probability: high, impact: medium.
→ Mitigation: v0 treats them as equal. v1 should weight by activity sub-type.

## Agent layer

### `[predicted]` Agent ignores tool output
The agent calls `analyze_training_load`, gets `acwr_status: "danger"`, and still recommends progression because plan.md says it's a build week. Probability: low (the rules are explicit) but a known LLM failure mode.
→ Mitigation: rules state ACWR overrides plan. Test case: feed it a synthetic week with ACWR 1.7 and a "progress" plan, verify it deloads.

### `[predicted]` Calendar event hallucination
Wrong day of week, wrong duration, mismatched title vs description. Probability: medium, impact: medium (annoying, requires manual cleanup).
→ Mitigation: JSON output schema enforced. Validation step in the agent's flow before pushing to Google Calendar. Failures should land in the summary email, not silently.

### `[predicted]` Plan drift across weeks
After 3 weeks of small adjustments, the calendar no longer resembles the original plan. Probability: medium, impact: high (defeats the purpose of having a plan).
→ Mitigation: agent must reconcile against the original plan, not last week. plan.md is the source of truth; history is just signal.

### `[predicted]` Over-deloading
Agent over-corrects on one bad workout. Two consecutive deloads = fitness loss.
→ Mitigation: escalation rule — two flag-triggered deloads in a row gets surfaced to me instead of auto-applied.

### `[predicted]` Strength day forgotten
Quality work + long run get all the attention. KOT exercises get dropped on busy weeks.
→ Mitigation: rules pin strength to Tue/Thu. The agent must include strength events even on adjustment weeks unless explicitly removed.

## Plumbing

### `[predicted]` Timezone math wrong on first run
Strava timestamps UTC, my calendar local. Off-by-7 hours.
→ Mitigation: plan.md declares `timezone: America/Los_Angeles`. Agent converts before calendar push.

### `[predicted]` Email summary lands in spam
Worker sending via SendGrid/Resend without proper DNS setup. Probability: high on first deploy.
→ Mitigation: v0 has the agent put the summary in the Claude Code task output (which I see in the cloud task UI) instead of email. Email later.

### `[predicted]` Schedule slips because computer was off
Not a concern — Claude Code cloud scheduled tasks run on Anthropic infra, no local dependency. (This is the reason for using cloud scheduled tasks over Cowork tasks.)

## Observed failures

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

### [observed 2026-05-15] /mcp pinned to 99.9% error rate by hung GET-SSE requests
What happened: the Cloudflare dashboard showed ~17k requests / ~17k errors over 24h on `running-coach.workers.dev`, sustained at ~0.5 req/s. Every error was `"The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response."` Tool calls (POST /mcp) still worked, so the agent was unaffected — the symptom was purely a flood of failing background requests.
Root cause: the Streamable HTTP transport defines `GET /mcp` (with `Accept: text/event-stream`) as the server→client SSE channel for server-initiated messages. Every Claude Code client that connects to the MCP opens that channel on startup. The transport is configured in stateless mode (`sessionIdGenerator: undefined`) because Workers have no persistent session state — but the SDK's `handleGetRequest` still happily returns a `ReadableStream` that never emits, regardless of mode ([webStandardStreamableHttp.js:184-250](../node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js)). The Worker runtime kills the request after its wall-clock budget; the client immediately reconnects; loop. Multiplied by every active Claude Code session = the spike. This affected every consumer of the plugin, not just my own session.
→ Fix: short-circuit non-POST methods on `/mcp` with a 405 + `Allow: POST` *before* constructing the MCP server. The MCP spec permits this for servers that don't implement server-initiated messages, which we don't. Also added `src/index.test.ts` covering GET→405, DELETE→405, POST without bearer→401, POST with wrong bearer→401, and POST with valid bearer + initialize→200 — the route layer previously had zero tests, which is what let this ship. Considered but rejected: moving to session mode with a Durable Object (over-engineered — we don't need server→client messages); bumping the SDK pin (the real fix belongs at our edge, not chasing SDK behavior). Worth filing upstream: in stateless mode the SDK should arguably 405 itself.
→ Status: applied

### [observed 2026-05-12] Monotony exploded on a zero-variation week
What happened: "60 TRIMP every day for 28 days" produced `monotony: 60`, which tripped the `monotony > 2.5` recovery override, so a perfectly steady, ACWR-1.0 block got `swap_for_recovery` instead of `execute_as_planned`.
Root cause: `sd = stddev(dailyLoads) || 1` — when all seven daily loads are identical, SD is 0 and the `|| 1` fallback makes `monotony = mean`, a number in TRIMP units (tens to hundreds) where Foster's monotony is dimensionless and ~1–2.5.
→ Fix: `monotony = sd > 0 ? mean/sd : 1`. A week with literally zero day-to-day variation is a degenerate case real data never hits (there is always a rest day or a pace difference); we report the neutral 1.0 there rather than a spurious large value. Tradeoff: this *under*-reports monotony risk for a hypothetical truly-uniform week — accepted, because (a) it can't happen with real Strava data and (b) ACWR and the volume/HR flags still cover the genuine overtraining signal. Revisit if real data ever produces a near-zero-SD week.
→ Status: applied (tradeoff: watching)

## What I'm explicitly not protecting against

- Strava API going down for a week. Manual planning that week, no big deal.
- The MCP server being compromised. Single-user, no PII beyond fitness data, blast radius is fine.
- Bad coaching advice causing injury. The system has escalation rules; I read every weekly summary; this isn't an autonomous medical device.
- Model regressions. If a future Claude generates worse plans, I'll pin the model version. Not preemptively engineering for it.
