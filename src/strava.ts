// Strava client. Handles token refresh, fetches activities, normalizes the shape
// so the rest of the code never deals with raw Strava JSON.

export type StravaActivity = {
  id: number
  type: string                    // "Run", "TrailRun", "VirtualRun", etc.
  start_date: string              // ISO UTC
  distance_km: number
  duration_min: number            // moving_time, not elapsed
  avg_pace_per_km: string         // formatted "m:ss"
  avg_hr: number | null
  max_hr: number | null
  total_elevation_gain_m: number
  // Coaching-relevant derivatives, computed here so tools don't have to:
  intensity_factor: number | null // avg_hr / LTHR
  hr_drift_pct: number | null     // null if no HR or too short
  est_trimp: number               // Banister TRIMP, falls back to RPE-estimated if no HR
  trimp_is_estimated: boolean
  is_long_run: boolean
}

export type StravaConfig = {
  clientId: string
  clientSecret: string
  kv: KVNamespace                 // stores { refresh_token, access_token, expires_at }
  athleteLTHR: number             // lactate threshold HR, from plan.md, e.g. 170
}

type TokenBundle = {
  refresh_token: string
  access_token: string
  expires_at: number              // unix seconds
}

// Strava's OAuth token endpoint response (the subset we use). Same shape for
// the authorization_code and refresh_token grants; `athlete` is only present
// on the initial authorization_code exchange.
export type StravaTokenResponse = {
  access_token: string
  refresh_token: string
  expires_at: number
  athlete?: { id: number }
}

// The Strava "list athlete activities" payload (subset). The full object has
// dozens of fields — polylines, segment efforts, kudos — none of which this
// coach needs. We read only what `normalize()` consumes.
type StravaApiActivity = {
  id: number
  type: string
  start_date: string              // ISO UTC
  distance: number                // metres
  moving_time: number             // seconds
  total_elevation_gain?: number   // metres
  has_heartrate: boolean
  average_heartrate?: number
  max_heartrate?: number
}

export class StravaClient {
  constructor(private config: StravaConfig) {}

  private async getAccessToken(): Promise<string> {
    const cached = await this.config.kv.get<TokenBundle>('tokens', 'json')
    if (!cached) {
      throw new Error('No Strava refresh token in KV. Run the OAuth bootstrap.')
    }
    const now = Math.floor(Date.now() / 1000)
    if (cached.access_token && cached.expires_at > now + 60) {
      return cached.access_token
    }
    // Refresh
    const res = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: cached.refresh_token,
      }),
    })
    if (!res.ok) throw new Error(`Strava token refresh failed: ${res.status}`)
    const data = await res.json() as StravaTokenResponse
    await this.config.kv.put('tokens', JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
    }))
    return data.access_token
  }

  async getActivities(days: number): Promise<StravaActivity[]> {
    const token = await this.getAccessToken()
    const after = Math.floor(Date.now() / 1000) - days * 86400
    const per_page = 100
    const res = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=${per_page}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) throw new Error(`Strava activities fetch failed: ${res.status}`)
    const raw = await res.json() as StravaApiActivity[]
    // Filter to running-ish only for this MCP. Bike rides etc. don't go through this coach.
    return raw
      .filter(a => ['Run', 'TrailRun', 'VirtualRun'].includes(a.type))
      .map(a => this.normalize(a))
  }

  private normalize(a: StravaApiActivity): StravaActivity {
    const distance_km = a.distance / 1000
    const duration_min = a.moving_time / 60
    const pace_sec_per_km = a.moving_time / distance_km
    const pace_min = Math.floor(pace_sec_per_km / 60)
    const pace_sec = Math.round(pace_sec_per_km % 60)
    const avg_hr = a.has_heartrate ? a.average_heartrate ?? null : null
    const max_hr = a.has_heartrate ? a.max_heartrate ?? null : null

    const intensity_factor = avg_hr ? +(avg_hr / this.config.athleteLTHR).toFixed(2) : null

    // TRIMP: Banister using HR reserve. Fallback: RPE-estimated by intensity bracket.
    let est_trimp: number
    let trimp_is_estimated = false
    if (avg_hr && this.config.athleteLTHR) {
      // Simplified Banister: TRIMP = duration_min × HRr × 0.64 × e^(1.92 × HRr)
      // Using avg_hr / LTHR as approximation of HR reserve here for simplicity.
      const hrr = avg_hr / this.config.athleteLTHR
      est_trimp = Math.round(duration_min * hrr * 0.64 * Math.exp(1.92 * hrr))
    } else {
      trimp_is_estimated = true
      // RPE bracket from pace; very rough. Better than nothing for missing-strap runs.
      est_trimp = Math.round(duration_min * 0.7) // assume zone-2-ish
    }

    return {
      id: a.id,
      type: a.type,
      start_date: a.start_date,
      distance_km: +distance_km.toFixed(2),
      duration_min: +duration_min.toFixed(1),
      avg_pace_per_km: `${pace_min}:${String(pace_sec).padStart(2, '0')}`,
      avg_hr,
      max_hr,
      total_elevation_gain_m: a.total_elevation_gain ?? 0,
      intensity_factor,
      hr_drift_pct: null, // requires streams API; v0.2
      est_trimp,
      trimp_is_estimated,
      is_long_run: distance_km >= 12, // crude — refine per athlete
    }
  }
}
