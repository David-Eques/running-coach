// Baseline tests for the coaching load model.
// These document expected behavior and prevent silent regressions when
// thresholds get tuned. If you change a formula in analyze.ts, update
// these tests in the same change.

import { describe, it, expect } from 'vitest'
import { analyzeTrainingLoad, suggestNextWorkout } from './analyze'
import type { StravaActivity } from './strava'

function mkActivity(opts: Partial<StravaActivity> & { daysAgo: number; trimp: number }): StravaActivity {
  const date = new Date(Date.now() - opts.daysAgo * 86400_000).toISOString()
  return {
    id: Math.floor(Math.random() * 1e9),
    type: 'Run',
    start_date: date,
    distance_km: 8,
    duration_min: 45,
    avg_pace_per_km: '5:38',
    avg_hr: 150,
    max_hr: 165,
    total_elevation_gain_m: 0,
    intensity_factor: 0.88,
    hr_drift_pct: null,
    est_trimp: opts.trimp,
    trimp_is_estimated: false,
    is_long_run: false,
    ...opts,
  }
}

describe('analyzeTrainingLoad', () => {
  it('returns zeroed analysis for empty input', () => {
    const r = analyzeTrainingLoad([])
    expect(r.acute_load_7d).toBe(0)
    expect(r.chronic_load_28d).toBe(0)
    expect(r.acwr).toBe(0)
    expect(r.acwr_status).toBe('undertraining')
  })

  it('classifies steady load (~equal weekly TRIMP) as optimal', () => {
    // 60 TRIMP/day across 28 days = 420/week acute, 1680 chronic, ACWR = 1.0
    const activities: StravaActivity[] = []
    for (let d = 0; d < 28; d++) {
      activities.push(mkActivity({ daysAgo: d, trimp: 60 }))
    }
    const r = analyzeTrainingLoad(activities)
    expect(r.acwr).toBeGreaterThan(0.9)
    expect(r.acwr).toBeLessThan(1.1)
    expect(r.acwr_status).toBe('optimal')
    // The four weekly buckets partition the 28-day window exactly.
    expect(r.weekly_loads.reduce((a, b) => a + b, 0)).toBe(r.chronic_load_28d)
    // Zero day-to-day variation is the degenerate SD=0 case: monotony must be
    // the neutral 1.0, not a spurious large number that would trip a deload.
    expect(r.monotony).toBe(1)
  })

  it('keeps the 7-day acute window at exactly 7 days', () => {
    // One run per day for 14 days. The acute (7d) load is 7 runs, not 8 — an
    // activity timestamped exactly 7 days ago belongs to last week's bucket.
    const activities: StravaActivity[] = []
    for (let d = 0; d < 14; d++) activities.push(mkActivity({ daysAgo: d, trimp: 50 }))
    const r = analyzeTrainingLoad(activities)
    expect(r.acute_load_7d).toBe(7 * 50)
    expect(r.weekly_loads[r.weekly_loads.length - 1]).toBe(r.acute_load_7d)
  })

  it('classifies a sudden volume spike as danger', () => {
    // Light 3 weeks then a huge final week
    const activities: StravaActivity[] = []
    for (let d = 7; d < 28; d++) activities.push(mkActivity({ daysAgo: d, trimp: 30 }))
    for (let d = 0; d < 7; d++) activities.push(mkActivity({ daysAgo: d, trimp: 150 }))
    const r = analyzeTrainingLoad(activities)
    expect(r.acwr).toBeGreaterThan(1.5)
    expect(r.acwr_status).toBe('danger')
  })

  it('flags returning from a long layoff', () => {
    // No training for 3+ weeks, one easy run yesterday
    const activities = [mkActivity({ daysAgo: 1, trimp: 30 })]
    const r = analyzeTrainingLoad(activities)
    expect(r.flags).toContain('three_consecutive_weeks_no_training')
  })

  it('reports data quality based on HR coverage', () => {
    const activities: StravaActivity[] = []
    for (let d = 0; d < 10; d++) {
      activities.push(mkActivity({
        daysAgo: d,
        trimp: 50,
        trimp_is_estimated: d < 3, // 3 of 10 missing HR
      }))
    }
    const r = analyzeTrainingLoad(activities)
    expect(r.data_quality.activities_analyzed).toBe(10)
    expect(r.data_quality.activities_with_hr).toBe(7)
    expect(r.data_quality.coverage_pct).toBe(70)
  })
})

describe('suggestNextWorkout', () => {
  it('recommends as-planned in optimal ACWR zone', () => {
    const activities: StravaActivity[] = []
    for (let d = 0; d < 28; d++) activities.push(mkActivity({ daysAgo: d, trimp: 60 }))
    const r = suggestNextWorkout({
      activities,
      plan_phase: 'Half marathon plan, week 6 of 12, intermediate',
      target_workout: 'Tempo 5mi at HM pace',
    })
    expect(r.recommendation).toBe('execute_as_planned')
    expect(r.adjusted_workout.target_volume_pct).toBe(100)
  })

  it('deloads in the danger zone', () => {
    const activities: StravaActivity[] = []
    for (let d = 7; d < 28; d++) activities.push(mkActivity({ daysAgo: d, trimp: 30 }))
    for (let d = 0; d < 7; d++) activities.push(mkActivity({ daysAgo: d, trimp: 150 }))
    const r = suggestNextWorkout({
      activities,
      plan_phase: 'Half marathon plan, week 6 of 12',
      target_workout: 'Tempo 5mi at HM pace',
    })
    expect(r.recommendation).toBe('adjust_volume')
    expect(r.adjusted_workout.target_volume_pct).toBeLessThan(100)
  })

  it('reports low confidence when HR data is sparse', () => {
    const activities: StravaActivity[] = []
    for (let d = 0; d < 10; d++) {
      activities.push(mkActivity({ daysAgo: d, trimp: 50, trimp_is_estimated: true }))
    }
    const r = suggestNextWorkout({
      activities,
      plan_phase: 'Week 1',
      target_workout: 'Easy 3mi',
    })
    expect(r.confidence).toBe('low')
  })
})
