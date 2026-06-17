// Route-layer tests for the worker's HTTP surface. The /mcp route must reject
// any method other than POST: a GET with Accept: text/event-stream opens an SSE
// stream the stateless transport can never serve, which the Worker runtime kills
// as "code had hung" and the client then reconnects in a loop. These tests pin
// that behavior so a later "tidy up" of the transport setup can't bring it back.

import { describe, it, expect } from 'vitest'
import app from './index'

const env = {
  STRAVA_CLIENT_ID: 'test_id',
  STRAVA_CLIENT_SECRET: 'test_secret',
  MCP_BEARER_TOKEN: 'test_bearer',
  ATHLETE_LTHR: '170',
  // The /mcp route doesn't touch KV during initialize; a bare stub is fine.
  STRAVA_TOKENS: {} as KVNamespace,
}

describe('/mcp route', () => {
  it('returns 405 for GET (stateless transport cannot sustain SSE on Workers)', async () => {
    const res = await app.request(
      '/mcp',
      { method: 'GET', headers: { Authorization: 'Bearer test_bearer' } },
      env,
    )
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('POST')
  })

  it('returns 405 for DELETE (no sessions to delete in stateless mode)', async () => {
    const res = await app.request(
      '/mcp',
      { method: 'DELETE', headers: { Authorization: 'Bearer test_bearer' } },
      env,
    )
    expect(res.status).toBe(405)
  })

  it('rejects POST without a bearer token', async () => {
    const res = await app.request('/mcp', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })

  it('rejects POST with the wrong bearer token', async () => {
    const res = await app.request(
      '/mcp',
      { method: 'POST', headers: { Authorization: 'Bearer wrong' } },
      env,
    )
    expect(res.status).toBe(401)
  })

  it('accepts an initialize handshake with the correct bearer', async () => {
    const res = await app.request(
      '/mcp',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test_bearer',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.0' },
          },
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { result?: { serverInfo?: { name?: string } } }
    expect(body.result?.serverInfo?.name).toBe('running-coach')
  })
})

describe('public routes', () => {
  it('GET / renders the home page without auth', async () => {
    const stubKV = {
      get: async () => null,
    } as unknown as KVNamespace
    const res = await app.request('/', { method: 'GET' }, { ...env, STRAVA_TOKENS: stubKV })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('GET /status returns JSON without auth', async () => {
    const stubKV = {
      get: async () => null,
    } as unknown as KVNamespace
    const res = await app.request('/status', { method: 'GET' }, { ...env, STRAVA_TOKENS: stubKV })
    expect(res.status).toBe(200)
    const body = await res.json() as { name: string; strava_connected: boolean }
    expect(body.name).toBe('running-coach')
    expect(body.strava_connected).toBe(false)
  })
})

describe('/oauth/connect re-auth guard', () => {
  // KV that reports an existing Strava token (i.e. the Worker is already connected).
  const connectedKV = {
    get: async (key: string) =>
      key === 'tokens' ? { refresh_token: 'r', access_token: 'a', expires_at: 9_999_999_999 } : null,
    put: async () => {},
  } as unknown as KVNamespace

  it('blocks re-authorization without the bearer once connected', async () => {
    const res = await app.request('/oauth/connect', { method: 'GET' }, { ...env, STRAVA_TOKENS: connectedKV })
    expect(res.status).toBe(401)
  })

  it('allows re-authorization with the correct bearer (?token=)', async () => {
    const res = await app.request('/oauth/connect?token=test_bearer', { method: 'GET' }, { ...env, STRAVA_TOKENS: connectedKV })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('strava.com/oauth/authorize')
  })

  it('allows first-time connect with no token yet (no bearer needed)', async () => {
    const freshKV = { get: async () => null, put: async () => {} } as unknown as KVNamespace
    const res = await app.request('/oauth/connect', { method: 'GET' }, { ...env, STRAVA_TOKENS: freshKV })
    expect(res.status).toBe(302)
  })

  it('blocks a setup-state callback from overwriting an existing token (replay)', async () => {
    // A `setup` state was minted during open first-time setup; a token now exists.
    // The callback must refuse to write rather than let the pre-armed state hijack it.
    const kv = {
      get: async (key: string) => {
        if (key.startsWith('oauth_state:')) return 'setup'
        if (key === 'tokens') return { refresh_token: 'r', access_token: 'a', expires_at: 9_999_999_999 }
        return null
      },
      delete: async () => {},
      put: async () => {},
    } as unknown as KVNamespace
    const res = await app.request(
      '/oauth/callback?code=x&state=S&scope=activity:read_all',
      { method: 'GET' },
      { ...env, STRAVA_TOKENS: kv },
    )
    expect(res.status).toBe(409)
  })

  it('fails closed when MCP_BEARER_TOKEN is unset (no re-auth bypass)', async () => {
    const res = await app.request(
      '/oauth/connect',
      { method: 'GET', headers: { Authorization: 'Bearer ' } },
      { ...env, MCP_BEARER_TOKEN: '', STRAVA_TOKENS: connectedKV },
    )
    expect(res.status).toBe(401)
  })
})
