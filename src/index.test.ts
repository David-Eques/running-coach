// Route-layer tests for the worker. These exist because we previously had no
// coverage for the HTTP surface (only analyze.ts was tested), and a real
// incident — 17k "code had hung" errors over 24h — came from the /mcp route
// accepting a method it can't actually serve. See FAILURE_MODES.md
// [observed 2026-05-15]. Without these, the next person who "tidies up" the
// transport setup brings the loop back.

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
