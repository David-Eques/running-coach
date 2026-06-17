# Architecture

## Problem statement

Build a weekly automated run-planning loop that adapts to actual training response: progress when load is being absorbed, deload when it isn't, skip-and-repair when life happens. The plan lives in Google Calendar so it shows up where I already look.

## Design tension at the center

LLMs are good at judgment calls and bad at consistent arithmetic. Load models are the opposite. The architecture choice that drives most of what follows: **put the load math in code, behind tools; let the LLM decide what to do with the answers**.

A tool named `analyze_training_load` forces a load model to exist. A prompt that says "consider training load" doesn't.

## Why MCP

The same job could be done with:

- **A Python script + cron.** Works, but the load logic gets tangled with the agent logic in one file. Hard to expose to other interfaces. No reuse for ad-hoc questions ("hey Claude, was last week a deload?").
- **An LLM with raw API access.** The agent does the math each time, which means the math is non-deterministic and untestable.
- **Zapier / Make.** No real domain logic possible. Just plumbing.

MCP gives:

1. **A typed tool surface that names what matters.** When the surface is `get_activities`, the LLM thinks like a Strava API client. When it's `analyze_training_load`, the LLM thinks like a coach.
2. **Multi-client reuse.** Cloud scheduled task uses it weekly. Desktop client uses it for "explain last week." A future iOS Shortcut could use it too. The compute happens once.
3. **A seam for testing.** `computeACWR()` can be unit-tested without an LLM in the loop.

## Tool design philosophy: coaching-shaped, not API-shaped

The Strava MCPs on GitHub mostly expose `get_activities`, `get_athlete`, `get_segment`. That's an API mirror. It pushes domain logic into the prompt, which is the wrong place.

This MCP exposes verbs at the level of the agent's intent:

### `get_recent_training(days)`

Returns a normalized list. Each activity (see `StravaActivity` in `src/strava.ts`):

```ts
{
  id: 12345678901,
  type: "Run",                // "Run" | "TrailRun" | "VirtualRun"
  start_date: "2026-05-08T14:23:00Z",
  distance_km: 8.2,
  duration_min: 42.3,
  avg_pace_per_km: "5:09",
  avg_hr: 152,                // null when no HR recorded
  max_hr: 168,                // null when no HR recorded
  total_elevation_gain_m: 47,
  // Coaching-relevant derivatives:
  intensity_factor: 0.90,     // avg_hr relative to LTHR; null when no HR
  hr_drift_pct: null,         // 2nd half vs 1st half HR — needs the streams API; not in v0.1
  est_trimp: 67,              // Banister TRIMP (HR-based) or RPE-estimated fallback
  trimp_is_estimated: false,  // true when HR was missing and TRIMP fell back to RPE
  is_long_run: false          // distance_km >= 12
}
```

Not present: GPS polylines, segment efforts, kudos count. The agent doesn't need them.

### `analyze_training_load(weeks=4)`

Returns (see `LoadAnalysis` in `src/analyze.ts`):

```ts
{
  acute_load_7d: 421,          // sum TRIMP last 7 days
  chronic_load_28d: 1654,      // sum TRIMP last 28 days
  acwr: 1.06,                  // acute / (chronic/4) — optimal ~0.8-1.3
  acwr_status: "optimal",      // "undertraining" | "optimal" | "threshold" | "danger"
  weekly_loads: [380, 410, 440, 421],   // [oldest, ..., current]
  trend: "stable_progressive", // "declining" | "stable" | "stable_progressive" | "spiking"
  monotony: 1.8,               // Foster's monotony: mean / SD of daily loads
  strain: 757,                 // monotony × acute_load_7d
  flags: [
    // Currently emitted (see computeFlags in analyze.ts):
    //   "volume_dropped_by_more_than_half_vs_prev_week"
    //   "three_consecutive_weeks_no_training"
    // HR-drift / resting-HR flags are out of scope until the streams API lands.
  ],
  data_quality: {
    activities_analyzed: 18,
    activities_with_hr: 16,
    coverage_pct: 89
  }
}
```

Decisions baked in:

- **Banister TRIMP** because HR is in every recent-ish Strava run that was recorded with a strap. Could swap for TSS if power becomes available.
- **ACWR thresholds** from Gabbett's work (`< 0.8` undertraining, `≤ 1.3` optimal, `≤ 1.5` threshold, `> 1.5` danger). Debated in the literature but actionable.
- **Monotony** from Foster (1998), neutralized to 1.0 on zero-variance weeks.
- **Half-open `(lower, upper]` windows everywhere** so the four weekly buckets partition the 28-day window exactly — `sum(weekly_loads) == chronic_load_28d` always.

All of these live in `src/analyze.ts` with citations in the file header, so the current values can be revisited against their sources.

### `suggest_next_workout(plan_phase, target_workout, day_of_week?)`

The agent passes its plan context as text (`plan_phase`, e.g. `"Half marathon plan, week 6 of 12, intermediate"`) and the next planned workout (`target_workout`, `"Tempo run 5mi at half marathon pace"`). The tool returns:

```ts
{
  recommendation: "execute_as_planned" | "adjust_intensity" | "adjust_volume" | "swap_for_recovery" | "skip",
  adjusted_workout: {...},
  rationale: ["ACWR 1.06 — in optimal zone", "HR drift trending up but within limits"],
  confidence: "high" | "medium" | "low"
}
```

The actual deload/progress *thresholds* live in code (in `src/analyze.ts`). The agent doesn't get to invent them. What the agent decides is: how to phrase it on the calendar, which day to put what on given how the week shapes up, when to communicate concern to me in the email summary.

## Tech stack

- **Runtime:** Cloudflare Workers. Free tier covers this workload comfortably. Cold starts ~5ms. Edge locations don't matter here; the developer experience does.
- **Framework:** Hono. Minimal router that plays well with the MCP SDK.
- **Protocol:** MCP Streamable HTTP from `@modelcontextprotocol/sdk` (pinned to `1.29.0`). Specifically the *Web Standards* transport (`WebStandardStreamableHTTPServerTransport`) — it speaks Fetch `Request`/`Response`, which is what a Worker hands you; the Node-HTTP transport (`StreamableHTTPServerTransport`) wants `IncomingMessage`/`ServerResponse` and doesn't fit. Stateless mode (a fresh `McpServer` + transport per request) — there's no per-session state to keep, and keeping any would mean a Durable Object, which this doesn't need.
- **Storage:** Workers KV for the Strava refresh token. Single user, single record — KV is overkill but cheaper than running a database for one row.
- **Config:** non-secret deployment vars in `wrangler.toml` (`ATHLETE_LTHR`, the athlete's lactate-threshold HR that drives the TRIMP estimate); secrets (`STRAVA_CLIENT_ID/SECRET`, `MCP_BEARER_TOKEN`) via `wrangler secret put`. Single-tenant, so this lives in the deployment, not a per-user profile.
- **Auth:** static bearer token between Claude Code and the MCP. Strava OAuth between the MCP and Strava (refresh token in KV, access tokens minted on demand).

## Distribution / install model (v0.1)

Designed so a non-technical user can deploy their own copy in three clicks:

1. **"Deploy to Cloudflare" button** in the README forks this repo into the user's GitHub, provisions the Worker + KV namespace + Builds CI from `wrangler.toml`, and prompts for `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` / `MCP_BEARER_TOKEN` (described in `.dev.vars.example`). Returns a `https://running-coach.<their-subdomain>.workers.dev` URL.
2. **Browser OAuth flow on the Worker itself** — `GET /` renders an HTML home page with a *Connect Strava* button, which redirects to Strava's authorize endpoint with `redirect_uri = <worker>/oauth/callback`. The callback exchanges the code, writes the refresh-token bundle to KV, and renders a success page with the exact `claude mcp add` command for that worker URL + bearer token. The legacy `/bootstrap` curl flow stays available for back-compat with single-user installs.
3. **Claude Code plugin** at `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json` plus a `skills/weekly-plan/SKILL.md` that wraps `agent/prompt.md`. Installs via `/plugin marketplace add David-Eques/running-coach` → `/plugin install running-coach@running-coach`. MCP wiring (`.mcp.json`) uses `${RUNNING_COACH_URL}` and `${RUNNING_COACH_BEARER}` env-var substitution so the per-user URL/token aren't baked into the plugin manifest.

The remaining friction the user has to do themselves: create a Strava API app (2 min in browser, copy two strings), and update its Authorization Callback Domain to their workers.dev host after deploy. That's the irreducible part.

The user's `agent/plan.md` ships as a *template* full of `<your_*>` placeholders. The agent prompt's first action on each run is to detect those placeholders and, if present, branch into a first-run wizard that collects the 9 athlete-config answers in chat and writes the filled plan.md. After that, the same prompt does the normal weekly review on every subsequent invocation.

## What I deliberately left out of v0

- **Multi-user support.** Single tenant. Auth is a static bearer token. If anyone else wants to use this they fork it.
- **Garmin direct integration.** Garmin's Health API needs a partner agreement. Garmin → Strava sync (free, native) covers it.
- **Webhooks.** Polling on a weekly cadence is fine. Webhooks would matter if I wanted real-time analysis after every run, which I don't.
- **Writes to Strava.** No writing. Reads only. Reduces blast radius.
- **A coach persona / chat memory.** This is a scheduled-task system, not a chatbot. If I want ad-hoc queries, that's the Desktop client hitting the same MCP, which doesn't need persistent memory.

## What I'd reach for next

In order of likely value:

1. **Garmin Wellness pull (HRV, resting HR, sleep).** Single biggest unlock — recovery state is half of "should I deload." Path: Garmin Health Snapshot through some scraping or partner API.
2. **Plan-aware tooling.** Right now the plan context is a string passed to the tool. A tool that knows the plan (`get_plan_position()`) would be cleaner.
3. **Race-day prediction.** Given current load trajectory, predict goal-pace feasibility for the target race. Useful for "should I adjust the goal time."
4. **Multi-user OAuth.** If the writeup gets attention and people ask for a hosted version.

## What an enterprise version would look like

Different problem, different shape. An enterprise coaching agent (think team / coach platform) would:

- Multi-tenant from day 1 with proper OAuth per user
- Coach in the loop — tool outputs flow to a coach UI, not directly to athlete calendars
- Audit trail on every adjustment (who/what/why)
- Different load models for different sports
- Configurable thresholds per athlete (e.g. younger athletes can absorb higher ACWR)
- Region/timezone handling
- A "do not contact" / safety layer if overreaching flags fire

This v0 is intentionally not that. It's a reference for the *pattern*, not the platform.
