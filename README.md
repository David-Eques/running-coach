# running-coach

An AI running coach that lives in your Google Calendar. It reads your Strava, computes training load **deterministically in versioned code**, and writes next week's workouts as a weekly Claude Code task. Built as a reference implementation for **coaching-shaped MCP tools** — exposing domain primitives (`analyze_training_load`, `suggest_next_workout`) to an LLM agent instead of mirroring a vendor REST API.

[![check](https://github.com/David-Eques/running-coach/actions/workflows/check.yml/badge.svg)](https://github.com/David-Eques/running-coach/actions/workflows/check.yml)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/David-Eques/running-coach)

**Read the design:** [Architecture](./ARCHITECTURE.md) · [Prompt design](./PROMPT_DESIGN.md)

## Demo

![running-coach end to end: the week in Google Calendar, asking the MCP to summarize recent training, then the Sunday routine planning next week and writing it to the calendar](docs/walkthrough.gif)

The week in Google Calendar, asking the MCP *"summarize my last 4 weeks,"* then the Sunday routine running end to end — reading Strava, calling the load-model tools, and writing next week's workouts to Google Calendar. *(Routine run sped up.)*

<details>
<summary><b>Under the hood</b> — the MCP returns a coach's read, not Strava JSON</summary>

<br>

![running-coach: the MCP returning coaching-shaped training-load analytics](docs/demo.gif)

ACWR and its status zone, weekly load trend, monotony/strain, and a deload/progress/skip recommendation with a rationale — all computed in [`src/analyze.ts`](./src/analyze.ts), not guessed by the model.

</details>

## Why this exists

I wanted automated weekly run planning that actually responds to how I'm doing — deload when I'm overreaching, progress when I'm absorbing the load, skip a workout if I clearly skipped real life. Existing solutions split into two camps: static plan generators (the popular PDF plans, vendor coaching apps) that don't adapt to what actually happened, and pure-LLM coaches that hallucinate volume changes because they have no real load model.

This sits in between: a deterministic load model in code, exposed as MCP tools, with an LLM doing the judgment calls (which adjustment, how to communicate it, which day to put what on).

## Why MCP, not a direct API call from the agent

The agent could absolutely just `fetch()` Strava itself. The reason to add an MCP layer:

1. **Tool design as forcing function.** Naming a tool `analyze_training_load` forces me to pick a load model, document it, and version it. A free-form fetch shifts that thinking into the prompt where it gets lost between iterations.
2. **Stable interface across clients.** The same MCP serves Claude Code's cloud scheduled task, Claude Desktop for ad-hoc questions ("how was last week?"), and any future agent.
3. **The coaching logic deserves its own home.** ACWR calculation, deload heuristics, HR drift detection — none of that belongs in a prompt. It belongs in tested code the LLM calls.
4. **Cost.** Pre-aggregating a month of activities into one structured response costs ~10× fewer tokens than the LLM looping over raw activity JSON.

## What it looks like end-to-end

```
┌──────────────────────────┐
│ Claude Code scheduled    │
│ task (Sunday 8pm)        │
│   - reads plan.md, kot.md│
│   - calls MCP tools      │
│   - writes to Calendar   │
└──────────┬───────────────┘
           │ MCP over HTTPS
           ▼
┌──────────────────────────┐
│ running-coach MCP        │
│ (Cloudflare Worker)      │
│   - get_recent_training  │
│   - analyze_training_load│
│   - suggest_next_workout │
└──────────┬───────────────┘
           │ Strava REST API
           ▼
┌──────────────────────────┐
│ Strava (source of truth) │
│  (Garmin → Strava sync)  │
└──────────────────────────┘
```

## Tools

| Tool | Returns | Why it's a tool, not a prompt instruction |
|---|---|---|
| `get_recent_training(days)` | Normalized activities with planned-vs-actual deltas, HR drift, intensity factor | The LLM shouldn't be parsing Strava's JSON or computing deltas — that's mechanical and error-prone |
| `analyze_training_load(weeks)` | ACWR, weekly TRIMP, monotony, strain, overreaching risk flags | Load math has correct answers. Putting it in code makes it testable and consistent. |
| `suggest_next_workout(plan_phase, target)` | Adjusted workout suggestion with rationale | Encapsulates the deload/progress decision rules so they're versioned, not buried in a prompt |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design thinking and [PROMPT_DESIGN.md](./PROMPT_DESIGN.md) for how the agent uses these tools.

## Deploy your own

It's single-tenant by design — one athlete per deployment. You run your own copy. You need: a Strava account, a Cloudflare account (free tier), a Google account, and a Claude Pro or Max plan (the weekly scheduled run needs it).

### 1. Create a Strava API app

Go to **https://www.strava.com/settings/api** and create an application:

| Field | Value |
|---|---|
| Application Name | `running-coach` (or anything) |
| Category | Training |
| Website | `http://localhost` (just a placeholder) |
| Authorization Callback Domain | leave as `localhost` for now — you'll update after step 2 |

Copy the **Client ID** and **Client Secret**.

### 2. Deploy the Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/David-Eques/running-coach)

The button forks this repo into your GitHub and deploys the Worker to `https://running-coach.<your-subdomain>.workers.dev`. It does **not** set your secrets — do that yourself once it's deployed, either with Wrangler:

```bash
wrangler secret put STRAVA_CLIENT_ID       # from your Strava app
wrangler secret put STRAVA_CLIENT_SECRET   # from your Strava app
wrangler secret put MCP_BEARER_TOKEN       # invent one: openssl rand -hex 32 — save it, you reuse it in step 3
```

or in the Cloudflare dashboard under **Worker → Settings → Variables and Secrets**. Prefer the CLI end to end (with explicit control over the KV namespace)? [SETUP.md](./SETUP.md) walks the whole deploy with Wrangler.

Then:

1. **Go back to your Strava app** at https://www.strava.com/settings/api and set **Authorization Callback Domain** to your Worker's host (e.g. `running-coach.your-subdomain.workers.dev`). Save.
2. **Visit your Worker URL** in a browser — click **Connect Strava**, authorize, done. The Worker now holds your Strava refresh token in KV and can read your activities.

### 3. Add the MCP to Claude Code

From the success page after connecting Strava, copy the `claude mcp add` command shown. Paste it in your terminal:

```bash
claude mcp add running-coach https://running-coach.<your-subdomain>.workers.dev/mcp \
  --transport http \
  --header "Authorization: Bearer <YOUR_MCP_BEARER_TOKEN>"
```

Open Claude Code in any project — `/mcp` shows the running-coach server with three tools. Ask: *"Use running-coach to summarize my last 4 weeks of training."* You should see a summary anchored in the computed numbers.

**Schedule the weekly run.** Go to **https://claude.ai/code/scheduled**, connect this project's repo, create a weekly scheduled task with `agent/prompt.md` as the prompt, Sunday 8 PM your timezone. Add the Google Calendar connector. The agent now runs itself every Sunday and writes next week's workouts to your calendar. For the weekly summaries to persist as cross-week memory, the routine needs write access to your repo and `agent/history/` un-gitignored — see [Routine requirements](./SETUP.md#routine-requirements-so-the-weekly-memory-persists) in SETUP.md.

First-time setup tip: open Claude Code with this repo as workspace and say *"Run a first-time setup — fill in agent/plan.md from these answers:..."* with your race details, paces, max HR, weekly mileage, strength days (the KOT / knees-over-toes program in `agent/kot.md`), and any constraints. The prompt's first-run branch asks for whatever it needs and writes the filled plan.

## Develop locally

```bash
git clone https://github.com/David-Eques/running-coach
cd running-coach
npm install
cp .dev.vars.example .dev.vars  # then fill in the values
npm run check                   # typecheck + tests
npm run dev                     # local Worker at http://localhost:8787
```

See [SETUP.md](./SETUP.md) for the manual deploy walkthrough (the CLI path the Deploy button shortcuts).

## Status

v0.1, public. The Worker is deployed and serving real Strava data through all three tools; the first week's calendar was generated and the weekly scheduled run is in flight. Single-tenant by design — fork it to run your own. This is a reference for the *pattern* (coaching-shaped tools, load math in code), not a hosted product.

## License

MIT. Not affiliated with Strava or Anthropic.
