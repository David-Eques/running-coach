# Setup

End-to-end deploy in under an hour assuming no surprises.

## Prerequisites

- A Cloudflare account (free tier is plenty).
- A Strava account.
- A Claude Pro or Max plan (for Claude Code cloud scheduled tasks).
- Node 20+, npm, and `wrangler` (`npm install -g wrangler`).

## 1. Strava API app

1. Go to https://www.strava.com/settings/api.
2. Create an application. Authorization callback domain: `localhost` for now (we use a one-time auth code flow; no public callback needed).
3. Note the **Client ID** and **Client Secret**.

## 2. Clone and install

```bash
git clone <this repo>
cd running-coach
npm install
npm run check     # typecheck + unit tests — should be all green before you go further
```

> If `wrangler dev` later dies with `The package "@cloudflare/workerd-darwin-arm64" could not be found, and is needed by workerd` (or the `-linux-64` / etc. equivalent for your platform), npm skipped one of workerd's platform-specific *optional* dependencies — a known npm bug. Fix: `npm install` again, or `rm -rf node_modules package-lock.json && npm install`, or install it directly: `npm install @cloudflare/workerd-darwin-arm64`. The committed `package-lock.json` should normally prevent this.

## 3. Cloudflare resources

```bash
wrangler login

# Create the KV namespace for Strava tokens.
wrangler kv namespace create STRAVA_TOKENS
# (Wrangler v3 used `kv:namespace`; the colon form is deprecated but still works.)
# Copy the returned `id` into wrangler.toml.

# Generate a strong bearer token for MCP auth. Save it; you'll need it twice.
openssl rand -hex 32
```

## 4. Set secrets

```bash
wrangler secret put STRAVA_CLIENT_ID
wrangler secret put STRAVA_CLIENT_SECRET
wrangler secret put MCP_BEARER_TOKEN   # paste the one from step 3
```

## 5. Deploy

```bash
wrangler deploy
```

Note your worker URL, e.g. `https://running-coach.<your-subdomain>.workers.dev`.

## 6. One-time Strava OAuth

Build this URL with your `client_id`:

```
https://www.strava.com/oauth/authorize?client_id=YOUR_ID&response_type=code&redirect_uri=http://localhost&approval_prompt=force&scope=activity:read_all
```

Open it. Authorize. You'll be redirected to `http://localhost/?code=<code>&scope=...`. The page won't load — that's fine. **Copy the `code` from the URL.**

Then hit your worker's bootstrap endpoint with that code:

```bash
curl -X GET "https://running-coach.<your-subdomain>.workers.dev/bootstrap?code=THE_CODE" \
  -H "Authorization: Bearer YOUR_MCP_BEARER_TOKEN"
```

You should see `{"ok": true, "athlete_id": ...}`. Strava tokens are now in your KV.

## 7. Wire up Claude Code

In your Claude Code project, add the MCP server. The exact mechanism depends on whether you're using the Desktop client or the CLI — the URL is your worker URL with `/mcp` appended, and the bearer token goes in the Authorization header.

Test by asking in a Claude Code session: *"What does my last week of training look like? Use the running-coach MCP."*

If the tools show up and `get_recent_training` returns activities, you're live.

## 8. (Once tools work) Schedule the task

Head to `claude.ai/code/scheduled`. Create a weekly task, Sunday 8pm. Paste the prompt from `agent/prompt.md`. Make sure the project has access to the MCP and your Google Calendar connector.

Run it manually a few times first. Don't put it on autopilot until you've eyeballed 2-3 outputs and they look right.

### Routine requirements (so the weekly memory persists)

The weekly run reads the last few `agent/history/*.md` summaries to spot multi-week patterns, and writes a new one each Sunday. It runs on a *fresh checkout* every week, so a summary that isn't committed and pushed is gone when the run ends. Two things must hold or the memory silently never accumulates:

1. **The routine needs write/push access to the repo it's connected to.** With read-only access the weekly `git push` fails. The prompt is written to flag a failed push in its summary, so watch for that on the first real run.
2. **`agent/history/` must be tracked in your repo.** This template gitignores `agent/history/*.md` (so the shared template never carries anyone's training data) — which also stops a fresh fork from adding new history files. In your own copy, delete the `agent/history/*.md` line from `.gitignore` so the weekly commit can track the file.

Those summaries are your training data. If your repo is public and you track history, that data is public — make the repo private if you'd rather it weren't.

## Troubleshooting

**MCP tools don't appear in Claude Code.** Bearer token mismatch or transport handshake issue. Hit `https://<your-worker>/mcp` directly with curl + the bearer token; you should get a JSON-RPC error about missing method, not a 401 or HTML.

**`get_recent_training` returns `[]` but you have runs.** The filter only includes `Run`, `TrailRun`, and `VirtualRun`. Open the worker logs (`wrangler tail`) to see the raw count before filtering.

**Strava 401.** The refresh token may have been revoked (you re-authed elsewhere). Re-run the bootstrap step.

**TRIMP looks too low.** Check `data_quality.coverage_pct`. If many activities lack HR, the estimator kicks in conservatively. Wear the strap.
