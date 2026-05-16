// Cloudflare Worker exposing the running coach MCP.
//
// Routes:
//   GET  /                  - HTML home page (connect Strava + install in Claude Code)
//   GET  /oauth/connect     - kicks off Strava OAuth (browser redirect)
//   GET  /oauth/callback    - Strava redirects back here with ?code=...
//   GET  /bootstrap         - legacy curl-based OAuth bootstrap (kept for back-compat)
//   GET  /status            - JSON: is the worker connected to Strava? (no secrets)
//   ALL  /mcp               - MCP Streamable HTTP endpoint (bearer-gated)
//
// MCP transport: Web-Standards (`WebStandardStreamableHTTPServerTransport`) —
// the Node-flavored `StreamableHTTPServerTransport` wants Node IncomingMessage /
// ServerResponse, which a Worker doesn't have. Stateless mode: a fresh server +
// transport per request because there is no per-session state to keep across
// requests on a Worker without a Durable Object. Pinned SDK: 1.29.0.

import { Hono } from 'hono'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { StravaClient, type StravaTokenResponse } from './strava'
import { analyzeTrainingLoad, suggestNextWorkout } from './analyze'

type Env = {
  STRAVA_CLIENT_ID: string
  STRAVA_CLIENT_SECRET: string
  MCP_BEARER_TOKEN: string
  // Lactate-threshold HR for the (single) athlete. A plain Worker var, not a
  // secret — it's not sensitive and it's tied to the deployment, not per-user.
  // Optional: defaults to 170 if unset/implausible. Set in wrangler.toml [vars]
  // or `wrangler deploy --var ATHLETE_LTHR:172`. Keep it in sync with agent/plan.md.
  ATHLETE_LTHR?: string
  STRAVA_TOKENS: KVNamespace
}

const DEFAULT_ATHLETE_LTHR = 170
const STRAVA_SCOPE = 'activity:read_all'

// Worker vars arrive as strings. Accept only a plausible HR; otherwise fall
// back to the default so a typo in config can't quietly distort every TRIMP.
function resolveAthleteLTHR(raw: string | undefined): number {
  const v = Number(raw)
  if (Number.isFinite(v) && v >= 120 && v <= 220) return v
  if (raw) console.warn(`ATHLETE_LTHR="${raw}" is not a plausible HR (120-220); using ${DEFAULT_ATHLETE_LTHR}`)
  return DEFAULT_ATHLETE_LTHR
}

// `Origin` of the incoming request — used as Strava's `redirect_uri`. The
// redirect_uri's host must exactly match the "Authorization Callback Domain"
// registered in the Strava app, so we always echo the host the user actually
// hit (not a hardcoded value).
function originOf(req: Request): string {
  const u = new URL(req.url)
  return `${u.protocol}//${u.host}`
}

type StoredTokenBundle = {
  refresh_token: string
  access_token: string
  expires_at: number
  athlete_id?: number
}

const app = new Hono<{ Bindings: Env }>()

// ---------------------------------------------------------------------------
// HOME PAGE — connect Strava + install in Claude Code
// ---------------------------------------------------------------------------

app.get('/', async (c) => {
  const origin = originOf(c.req.raw)
  const tokens = await c.env.STRAVA_TOKENS.get<StoredTokenBundle>('tokens', 'json')
  const connected = !!tokens
  const athleteId = tokens?.athlete_id
  const html = renderHome({ origin, connected, athleteId })
  return c.html(html)
})

// JSON health-check / status endpoint. Safe to expose publicly: doesn't include
// the bearer token, just whether Strava is wired up.
app.get('/status', async (c) => {
  const tokens = await c.env.STRAVA_TOKENS.get<StoredTokenBundle>('tokens', 'json')
  return c.json({
    name: 'running-coach',
    version: '0.1.0',
    strava_connected: !!tokens,
    athlete_id: tokens?.athlete_id ?? null,
    mcp_endpoint: `${originOf(c.req.raw)}/mcp`,
  })
})

// ---------------------------------------------------------------------------
// STRAVA OAUTH (browser flow)
// ---------------------------------------------------------------------------

// Step 1: send the user to Strava to authorize. We stash a random `state` in
// KV with a 10-minute TTL so the callback can verify the round-trip.
app.get('/oauth/connect', async (c) => {
  if (!c.env.STRAVA_CLIENT_ID) {
    return c.html(renderError('STRAVA_CLIENT_ID secret is not set on this Worker. Run `wrangler secret put STRAVA_CLIENT_ID` and try again.'), 500)
  }
  const state = crypto.randomUUID()
  await c.env.STRAVA_TOKENS.put(`oauth_state:${state}`, '1', { expirationTtl: 600 })
  const redirectUri = `${originOf(c.req.raw)}/oauth/callback`
  const authorize = new URL('https://www.strava.com/oauth/authorize')
  authorize.searchParams.set('client_id', c.env.STRAVA_CLIENT_ID)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('redirect_uri', redirectUri)
  authorize.searchParams.set('approval_prompt', 'force')
  authorize.searchParams.set('scope', STRAVA_SCOPE)
  authorize.searchParams.set('state', state)
  return c.redirect(authorize.toString(), 302)
})

// Step 2: Strava redirects back here with ?code= and ?state= (and ?scope=).
// Verify state, exchange code for tokens, persist to KV, render success page.
app.get('/oauth/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const scope = c.req.query('scope') ?? ''
  const error = c.req.query('error')
  if (error) return c.html(renderError(`Strava returned an error: ${error}`), 400)
  if (!code || !state) return c.html(renderError('Missing code or state parameter on the callback.'), 400)
  const stateMarker = await c.env.STRAVA_TOKENS.get(`oauth_state:${state}`)
  if (!stateMarker) return c.html(renderError('OAuth state expired or invalid. Start over from the home page.'), 400)
  await c.env.STRAVA_TOKENS.delete(`oauth_state:${state}`)
  if (!scope.includes('activity:read_all')) {
    return c.html(renderError('Required scope <code>activity:read_all</code> was not granted. Re-authorize and tick the box.'), 400)
  }
  const exchanged = await exchangeStravaCode(c.env, code)
  if (!exchanged.ok) {
    return c.html(renderError(`Strava token exchange failed (HTTP ${exchanged.status}). Double-check your Strava Client ID/Secret are set as Worker secrets.`), 500)
  }
  const data = exchanged.data
  const bundle: StoredTokenBundle = {
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    expires_at: data.expires_at,
    athlete_id: data.athlete?.id,
  }
  await c.env.STRAVA_TOKENS.put('tokens', JSON.stringify(bundle))
  return c.html(renderSuccess({ origin: originOf(c.req.raw), athleteId: bundle.athlete_id }))
})

async function exchangeStravaCode(env: Env, code: string): Promise<{ ok: true; data: StravaTokenResponse } | { ok: false; status: number }> {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    }),
  })
  if (!res.ok) return { ok: false, status: res.status }
  const data = await res.json() as StravaTokenResponse
  return { ok: true, data }
}

// ---------------------------------------------------------------------------
// LEGACY: curl-based bootstrap (kept so existing single-user installs don't break)
// ---------------------------------------------------------------------------

app.get('/bootstrap', async (c) => {
  const auth = c.req.header('authorization')
  if (auth !== `Bearer ${c.env.MCP_BEARER_TOKEN}`) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  const code = c.req.query('code')
  if (!code) return c.json({ error: 'missing code' }, 400)
  const exchanged = await exchangeStravaCode(c.env, code)
  if (!exchanged.ok) return c.json({ error: 'strava exchange failed', status: exchanged.status }, 500)
  const data = exchanged.data
  await c.env.STRAVA_TOKENS.put('tokens', JSON.stringify({
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    expires_at: data.expires_at,
    athlete_id: data.athlete?.id,
  }))
  return c.json({ ok: true, athlete_id: data.athlete?.id })
})

// ---------------------------------------------------------------------------
// MCP ENDPOINT (bearer-gated)
// ---------------------------------------------------------------------------

// Auth gate. Accepts the token via either:
//   - Authorization: Bearer <token>   (preferred — header, doesn't appear in URL logs)
//   - ?token=<token>                  (fallback — the claude.ai "custom connector"
//                                       UI accepts only a URL, no headers, so the
//                                       token has to ride in the URL. Less ideal:
//                                       URLs land in more places (browser history,
//                                       reverse-proxy logs, error pages) than
//                                       headers do. Prefer the header in CLI usage.)
app.use('/mcp/*', async (c, next) => {
  const auth = c.req.header('authorization')
  const tokenParam = c.req.query('token')
  const expected = c.env.MCP_BEARER_TOKEN
  const headerOk = auth === `Bearer ${expected}`
  const queryOk = tokenParam !== undefined && tokenParam === expected
  if (!headerOk && !queryOk) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
})

// The MCP Streamable HTTP transport defines a GET on the endpoint as the
// server→client SSE channel for server-initiated messages. In stateless mode
// each request gets a fresh transport with no way to push, so that stream
// would sit open forever and Workers would kill it with "code had hung"
// (~17k such errors observed before this gate was added; see FAILURE_MODES.md).
// We don't use server-initiated messages, so reject anything other than POST
// with 405 per the MCP spec.
app.all('/mcp', async (c) => {
  if (c.req.method !== 'POST') {
    return c.body(null, 405, { Allow: 'POST' })
  }
  const server = buildServer(c.env)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})

function buildServer(env: Env) {
  const server = new McpServer({
    name: 'running-coach',
    version: '0.1.0',
  })

  const strava = new StravaClient({
    clientId: env.STRAVA_CLIENT_ID,
    clientSecret: env.STRAVA_CLIENT_SECRET,
    kv: env.STRAVA_TOKENS,
    athleteLTHR: resolveAthleteLTHR(env.ATHLETE_LTHR),
  })

  server.tool(
    'get_recent_training',
    'Fetch recent running activities, normalized with derived coaching metrics ' +
    '(intensity factor, TRIMP, long-run flag). Use this when you need the raw ' +
    'session-by-session picture of the past N days.',
    {
      days: z.number().int().min(1).max(90).default(14)
        .describe('Days of history to fetch (1-90).'),
    },
    async ({ days }) => {
      const activities = await strava.getActivities(days)
      return {
        content: [{ type: 'text', text: JSON.stringify(activities, null, 2) }],
      }
    },
  )

  server.tool(
    'analyze_training_load',
    'Compute deterministic training load analytics: acute and chronic load (TRIMP), ' +
    'ACWR and status zone, weekly load trend, monotony, strain, and risk flags. ' +
    'Call this FIRST before making any recommendation about next week.',
    {
      weeks: z.number().int().min(2).max(12).default(4)
        .describe('Lookback window in weeks (2-12). 4 is the default per the load model.'),
    },
    async ({ weeks }) => {
      const activities = await strava.getActivities(weeks * 7)
      const analysis = analyzeTrainingLoad(activities)
      return {
        content: [{ type: 'text', text: JSON.stringify(analysis, null, 2) }],
      }
    },
  )

  server.tool(
    'suggest_next_workout',
    'Given a plan context and a target workout, return a structured recommendation ' +
    'that respects current load state. Encodes the deload / progress / swap / skip ' +
    'decision rules. The agent decides phrasing and scheduling; the math is here.',
    {
      plan_phase: z.string().describe(
        'Free-text plan context, e.g. "Half marathon plan, week 6 of 12, intermediate"',
      ),
      target_workout: z.string().describe(
        'The workout the plan calls for, e.g. "Tempo run 5mi at half marathon pace"',
      ),
      day_of_week: z.string().optional().describe(
        'Day this workout is planned for, if relevant for context',
      ),
    },
    async ({ plan_phase, target_workout, day_of_week }) => {
      const activities = await strava.getActivities(28)
      const suggestion = suggestNextWorkout({
        activities,
        plan_phase,
        target_workout,
        day_of_week,
      })
      return {
        content: [{ type: 'text', text: JSON.stringify(suggestion, null, 2) }],
      }
    },
  )

  return server
}

export default app

// ---------------------------------------------------------------------------
// HTML rendering — kept inline so the worker is one file, no template lib.
// Style is deliberately spartan; this is a config page, not a marketing site.
// ---------------------------------------------------------------------------

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.85rem; }
  .badge.ok { background: #e3f8e3; color: #1b6b1b; }
  .badge.warn { background: #fff4d6; color: #7a5b00; }
  .badge.err { background: #fde4e4; color: #8a1f1f; }
  .btn { display: inline-block; padding: 0.6rem 1rem; border-radius: 6px; background: #fc4c02; color: white; text-decoration: none; font-weight: 600; }
  .btn.secondary { background: #5f6368; }
  code { background: rgba(127,127,127,0.15); padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.9em; }
  pre { background: rgba(127,127,127,0.1); padding: 0.75rem; border-radius: 6px; overflow-x: auto; font-size: 0.85rem; }
  hr { border: none; border-top: 1px solid rgba(127,127,127,0.25); margin: 2rem 0; }
  .footer { font-size: 0.85rem; opacity: 0.7; margin-top: 3rem; }
</style>
</head>
<body>
${body}
<div class="footer">running-coach · MCP for weekly run planning · <a href="https://github.com/David-Eques/running-coach">source</a></div>
</body>
</html>`
}

function renderHome(opts: { origin: string; connected: boolean; athleteId?: number }): string {
  const status = opts.connected
    ? `<span class="badge ok">✓ Connected to Strava</span> ${opts.athleteId ? `<small>athlete ${opts.athleteId}</small>` : ''}`
    : `<span class="badge warn">Not connected to Strava yet</span>`
  const action = opts.connected
    ? `<p>You're set up. <a href="/oauth/connect" class="btn secondary">Re-authorize</a> if you ever switch Strava accounts.</p>`
    : `<p><a href="/oauth/connect" class="btn">Connect Strava</a></p>`
  return layout('running-coach', `
    <h1>running-coach</h1>
    <p>${status}</p>
    ${action}
    <hr>
    <h2>Add this MCP to Claude Code</h2>
    <p>From your terminal, in any project directory:</p>
    <pre><code>claude mcp add running-coach ${opts.origin}/mcp \\
  --transport http \\
  --header "Authorization: Bearer &lt;YOUR_MCP_BEARER_TOKEN&gt;"</code></pre>
    <p>Replace <code>&lt;YOUR_MCP_BEARER_TOKEN&gt;</code> with the bearer token you set as the <code>MCP_BEARER_TOKEN</code> secret at deploy time. (If you lost it, regenerate with <code>openssl rand -hex 32</code> and run <code>wrangler secret put MCP_BEARER_TOKEN</code>.)</p>
    <h2>JSON status</h2>
    <p><a href="/status">/status</a> returns whether the Worker is connected to Strava (no secrets).</p>
  `)
}

function renderSuccess(opts: { origin: string; athleteId?: number }): string {
  return layout('Connected', `
    <h1>✓ Strava connected</h1>
    <p>${opts.athleteId ? `Athlete <code>${opts.athleteId}</code> is authorized.` : 'Authorization succeeded.'} The Worker can now mint Strava access tokens on demand.</p>
    <h2>Next: add this MCP to Claude Code</h2>
    <p>From your terminal:</p>
    <pre><code>claude mcp add running-coach ${opts.origin}/mcp \\
  --transport http \\
  --header "Authorization: Bearer &lt;YOUR_MCP_BEARER_TOKEN&gt;"</code></pre>
    <p>(<code>MCP_BEARER_TOKEN</code> is the secret you set at deploy time.)</p>
    <p><a href="/" class="btn secondary">Back home</a></p>
  `)
}

function renderError(message: string): string {
  return layout('Error', `
    <h1><span class="badge err">Error</span></h1>
    <p>${message}</p>
    <p><a href="/" class="btn secondary">Back home</a></p>
  `)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string))
}
