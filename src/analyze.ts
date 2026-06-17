// Coaching logic — deterministic, testable, version-controlled.
// If you ever feel tempted to put any of this in a prompt, don't.
//
// References:
// - Banister TRIMP: Banister, E.W. (1991). Modeling elite athletic performance.
// - ACWR sweet spot: Gabbett, T.J. (2016). The training-injury prevention paradox.
// - Monotony/Strain: Foster, C. (1998). Monitoring training in athletes.
// Threshold choices here are defensible defaults, not gospel. Tune over time.

import type { StravaActivity } from './strava'

export type LoadAnalysis = {
  acute_load_7d: number
  chronic_load_28d: number
  acwr: number
  acwr_status: 'undertraining' | 'optimal' | 'threshold' | 'danger'
  weekly_loads: number[]          // most recent week last
  trend: 'declining' | 'stable' | 'stable_progressive' | 'spiking'
  monotony: number                // Foster's monotony: mean/SD of daily loads
  strain: number                  // monotony × weekly load
  flags: string[]
  data_quality: {
    activities_analyzed: number
    activities_with_hr: number
    coverage_pct: number
  }
}

export function analyzeTrainingLoad(activities: StravaActivity[]): LoadAnalysis {
  const now = Date.now()
  // Windows are half-open: (lower, upper]. The lower edge is exclusive so an
  // activity timestamped exactly N days ago lands in exactly one bucket, never
  // two — that keeps the 7-day window at 7 days (not 7 days + the boundary
  // instant) and makes the weekly buckets below partition `recent` exactly,
  // so the four weekly loads always sum to chronic_load_28d.
  const sevenDaysAgo = now - 7 * 86400_000
  const fourWeeksAgo = now - 28 * 86400_000

  const recent = activities.filter(a => new Date(a.start_date).getTime() > fourWeeksAgo)

  const acute_load_7d = sum(recent
    .filter(a => new Date(a.start_date).getTime() > sevenDaysAgo)
    .map(a => a.est_trimp))

  const chronic_load_28d = sum(recent.map(a => a.est_trimp))
  const chronic_avg_per_week = chronic_load_28d / 4

  const acwr = chronic_avg_per_week > 0
    ? +(acute_load_7d / chronic_avg_per_week).toFixed(2)
    : 0

  const acwr_status =
    acwr < 0.8 ? 'undertraining' :
    acwr <= 1.3 ? 'optimal' :
    acwr <= 1.5 ? 'threshold' : 'danger'

  // Weekly buckets, most recent week last. (weekStart, weekEnd] — see note above.
  const weekly_loads: number[] = []
  for (let w = 3; w >= 0; w--) {
    const weekStart = now - (w + 1) * 7 * 86400_000
    const weekEnd = now - w * 7 * 86400_000
    weekly_loads.push(sum(
      recent
        .filter(a => {
          const t = new Date(a.start_date).getTime()
          return t > weekStart && t <= weekEnd
        })
        .map(a => a.est_trimp)
    ))
  }

  const trend = detectTrend(weekly_loads)

  // Foster's monotony = mean / SD of daily training load over the last 7 days
  // (rest days count as 0). When SD is 0 the week has no day-to-day variation
  // at all — a degenerate case real data never hits (there is always a rest day
  // or a pace difference). The ratio is undefined there; we report the neutral
  // value 1.0 rather than a spurious large number so a deload decision never
  // hinges on that artifact.
  const dailyLoads = bucketByDay(recent.filter(a =>
    new Date(a.start_date).getTime() > sevenDaysAgo
  ), now)
  const mean = avg(dailyLoads)
  const sd = stddev(dailyLoads)
  const monotony = sd > 0 ? +(mean / sd).toFixed(2) : 1
  const strain = Math.round(monotony * acute_load_7d)

  const flags = computeFlags(weekly_loads)

  const activities_analyzed = recent.length
  const activities_with_hr = recent.filter(a => !a.trimp_is_estimated).length

  return {
    acute_load_7d,
    chronic_load_28d,
    acwr,
    acwr_status,
    weekly_loads,
    trend,
    monotony,
    strain,
    flags,
    data_quality: {
      activities_analyzed,
      activities_with_hr,
      coverage_pct: activities_analyzed
        ? Math.round((activities_with_hr / activities_analyzed) * 100)
        : 0,
    },
  }
}

function computeFlags(weekly_loads: number[]): string[] {
  const flags: string[] = []
  // Crude version. Refine with real data. weekly_loads is [oldest, ..., current].
  const lastWeek = weekly_loads[weekly_loads.length - 1]
  const prevWeek = weekly_loads[weekly_loads.length - 2]
  if (prevWeek > 0 && lastWeek < prevWeek * 0.5) {
    flags.push('volume_dropped_by_more_than_half_vs_prev_week')
  }
  // "Returning from a layoff": the three weeks *before* the current one were
  // empty. The current week may already have a re-introduction run in it — that
  // is exactly the case this flag exists to catch — so it must not be part of
  // the all-zero check. weekly_loads.slice(0, 3) is those three older weeks.
  if (weekly_loads.length >= 4 && weekly_loads.slice(0, 3).every(w => w === 0)) {
    flags.push('three_consecutive_weeks_no_training')
  }
  // hr_drift flags will land when the streams API is wired up.
  // computeFlags will take the activity list back as a parameter at that point.
  return flags
}

function detectTrend(weekly: number[]): LoadAnalysis['trend'] {
  if (weekly.length < 4) return 'stable'
  // weekly is [w-4, w-3, w-2, current]. The oldest bucket isn't used directly.
  const [, b, c, d] = weekly
  const last3 = [b, c, d].filter(x => x > 0)
  if (last3.length < 2) return 'declining'
  const slope = (d - b) / 2
  if (slope > b * 0.15) return 'spiking'
  if (slope < -b * 0.15) return 'declining'
  if (slope > 0) return 'stable_progressive'
  return 'stable'
}

// --- Suggestion logic ---

export type WorkoutSuggestion = {
  recommendation:
    | 'execute_as_planned'
    | 'adjust_intensity'
    | 'adjust_volume'
    | 'swap_for_recovery'
    | 'skip'
  adjusted_workout: {
    description: string
    target_volume_pct: number   // vs original
    target_intensity_pct: number // vs original
  }
  rationale: string[]
  confidence: 'high' | 'medium' | 'low'
}

export function suggestNextWorkout(input: {
  activities: StravaActivity[]
  plan_phase: string
  target_workout: string
  day_of_week?: string
}): WorkoutSuggestion {
  const load = analyzeTrainingLoad(input.activities)
  const rationale: string[] = [`ACWR ${load.acwr} — ${load.acwr_status}`]
  let recommendation: WorkoutSuggestion['recommendation'] = 'execute_as_planned'
  let target_volume_pct = 100
  let target_intensity_pct = 100

  // Flag overrides come first
  if (load.flags.includes('three_consecutive_weeks_no_training')) {
    recommendation = 'swap_for_recovery'
    target_volume_pct = 40
    target_intensity_pct = 70
    rationale.push('Returning from extended layoff — easy reintroduction')
  } else if (load.acwr_status === 'danger') {
    recommendation = 'adjust_volume'
    target_volume_pct = 75
    rationale.push('ACWR in danger zone — 25% deload to bring back to optimal')
  } else if (load.acwr_status === 'threshold') {
    recommendation = 'execute_as_planned'
    rationale.push('Threshold zone — execute but no progression beyond plan')
  } else if (load.acwr_status === 'undertraining') {
    recommendation = 'adjust_volume'
    target_volume_pct = 110
    rationale.push('Below optimal load — small bump (+10%) to progress')
  }

  // Monotony override — high monotony = injury risk even at good ACWR
  if (load.monotony > 2.5 && recommendation === 'execute_as_planned') {
    recommendation = 'swap_for_recovery'
    target_intensity_pct = 60
    rationale.push(`Monotony ${load.monotony} — week too uniform, inject a recovery day`)
  }

  const confidence: WorkoutSuggestion['confidence'] =
    load.data_quality.coverage_pct >= 75 ? 'high' :
    load.data_quality.coverage_pct >= 50 ? 'medium' : 'low'

  return {
    recommendation,
    adjusted_workout: {
      description: input.target_workout,
      target_volume_pct,
      target_intensity_pct,
    },
    rationale,
    confidence,
  }
}

// --- helpers ---

function sum(xs: number[]) { return xs.reduce((a, b) => a + b, 0) }
function avg(xs: number[]) { return xs.length ? sum(xs) / xs.length : 0 }
function stddev(xs: number[]) {
  if (xs.length < 2) return 0
  const m = avg(xs)
  return Math.sqrt(avg(xs.map(x => (x - m) ** 2)))
}
function bucketByDay(activities: StravaActivity[], now: number): number[] {
  const buckets = new Array<number>(7).fill(0)
  for (const a of activities) {
    const ageDays = Math.floor((now - new Date(a.start_date).getTime()) / 86400_000)
    if (ageDays >= 0 && ageDays < 7) buckets[ageDays] += a.est_trimp
  }
  return buckets
}
