# Training Plan

> **Fresh fork?** This file ships as a template — every `<your_*>` placeholder
> below is a value you (or the first-run wizard) need to fill in. Open Claude
> Code with this repo as the workspace and say *"Run the first-time setup"* —
> the wizard in [`agent/prompt.md`](./prompt.md) asks the questions and writes
> the filled version back to this file. Once filled, the weekly review takes
> over and the wizard doesn't fire again unless you reset placeholders.

The agent reads this file as the source of truth for the prescription AND
your scheduling preferences. The agent does not edit this file directly —
if the plan stops fitting reality, the agent surfaces it in the summary
email and the human revises.

## Athlete profile

```yaml
name: <your_name>
timezone: <your_timezone>             # e.g. America/Los_Angeles
units: <imperial|metric>
lthr: <your_lthr>                     # lactate-threshold HR. If unknown, 0.89 × max_hr.
                                      # Set ATHLETE_LTHR in wrangler.toml to the same value.
easy_pace: "<m:ss/mi>"                # conversational pace; plan reanchors as this improves
threshold_pace: "<m:ss/mi>"           # easy − 1:45, approximate
location: <your_city, state>          # affects altitude adjustment for race day
notes: |
  <free-text — recent training context, return from layoff, sport background,
  injuries, anything the agent should weigh.>
```

## Preferences

Defaults the agent uses when emitting calendar events. Edit any line; the
agent re-reads this file every run, so changes apply to next week's plan.

```yaml
default_run_time: "06:30"
default_strength_time: "06:30"
default_mobility_time: "19:30"
mobility_delivery: separate_event     # vs "in_run_description"
default_calendar: primary             # Google Calendar to push to
notification_method: popup            # popup = push, email = Calendar email
notification_minutes_before: 30
suppress_email_notifications: true
race_week_overrides:
  long_run_time: "07:00"              # match the race's actual start time
```

## Long-term arc (optional, not the goal for this race)

```yaml
arc: "<long-term running goal — e.g. sub-3 marathon over 3 years>"
horizon: "<this race is a checkpoint, not the attempt>"
```

## This race

```yaml
event: "<race name>"
date: <YYYY-MM-DD>
location: "<city, state>"
distance: <5k|10k|half|marathon|ultra>
course: "<flat road | trail | hilly>"
elevation_start_ft: <number or 0>
penalties_for_pace:
  trail: "<+0% road, +12-18% trail, +20-40% technical>"
  altitude: "<+0-7% depending on elevation and acclimation>"
  combined: "<rough multiplier vs flat-road equivalent>"
```

## Race-day goals (set, but training doesn't anchor to them)

The race targets get *pinned in the late peak week*, not now. The build aims
at fitness; the time falls out of where the fitness lands.

```yaml
A: "<set in late peak from observed fitness, or pin a target now>"
B: "<finish strong, fueled, smooth>"
C: "<finish healthy, no DNF>"
```

## Pace map (recomputed weekly from current easy pace)

All target paces are *relative* to easy. The agent re-derives them from the
most recent easy run each week.

```yaml
easy:       "<your_easy_pace>"
long:       "easy pace; final 20% can drop if HR is steady"
tempo:      "easy − 1:30"
threshold:  "easy − 1:45"
intervals:  "easy − 2:30"
marathon:   "set in late peak; not a training anchor before then"
hill_reps:  "by effort, not pace — hard up, easy down, full recovery"
strides:    "80–100m fast accelerations after an easy run"
```

## Phases

```yaml
base:   "weeks 1–N1   — easy + long, no quality, settle into strength rhythm"
build:  "weeks N1+1–N2 — add quality, grow long run"
peak:   "weeks N2+1–N3 — longest long runs, race-pace work"
taper:  "weeks N3+1–end — cut volume, sharpen, race"
```

## Adaptation rules (for the agent, not the athlete)

The skeleton below is a *prescription*. The agent calls
`mcp__running-coach__suggest_next_workout` for each session and may adjust
per the rules in `prompt.md`:

- ACWR-driven volume scaling per `acwr_status` (undertraining → +10%, threshold/danger → deload).
- Skip the strength session if a hard run flagged HR drift.
- Re-derive workout paces from the most recent easy run, not from this file.
- Surface, never overwrite, deviations from this skeleton.

If three consecutive weeks come in >20% under the prescribed mileage, treat
that as a signal that the plan is over-prescribed and escalate.

## Week-by-week skeleton

```yaml
# Fill in N weeks of (mon..sun) entries appropriate to your race date.
# Day shapes:
#   rest
#   { type: easy|tempo|hills|intervals|long|race, miles: N, ... }
#   { type: strength, strength: kot_a|kot_b }
# Optional fields on run days:
#   mobility: mobility_midweek | mobility_weekend
#   strides: "N × 100m after"
#   note: "free-text — workout details"

- week: 1
  mon: { type: easy, miles: <n> }
  tue: { type: strength, strength: kot_a }
  wed: { type: easy, miles: <n>, mobility: mobility_midweek }
  thu: { type: strength, strength: kot_b }
  fri: { type: easy, miles: <n> }
  sat: { type: long, miles: <n>, mobility: mobility_weekend }
  sun: rest
  weekly_miles: <n>
```
