# Prompt Design

The scheduled task prompt is the agent's job description. It's been through several rewrites; this doc is the running log of what changed and why. If you only read one section, read [Decision rules](#decision-rules) — that's where most of the leverage is.

## The agent's job

Every Sunday evening: review the past 7 days against the training plan, decide what next week should look like, write it to Google Calendar, summarize choices in an email.

## Top-level prompt shape

The full prompt lives in `agent/prompt.md`. Structurally:

1. **Role and authority limits** — coach, not doctor. Plan adjustments yes; medical advice no.
2. **Sources of truth** — plan.md, kot.md, history/, MCP tools (in that priority order).
3. **Tool call sequence** — the deterministic order the agent should call tools in.
4. **Decision rules** — when to deload, when to progress, when to swap.
5. **Output requirements** — calendar event format, summary email format.
6. **Escalation rules** — when to stop adjusting and just send me a message.

## What changed and why

### v0: "Be a smart coach using my Strava data"

Predictably terrible. The agent invented load math, hallucinated paces, and once gave me a 24-mile long run in week 3.

**Lesson:** "Smart" is not a specification. The MCP tools didn't exist yet, and even when I described training load in prose, the LLM couldn't apply it consistently across calls.

### v1: Added tool-first sequence

Forced the agent to call `analyze_training_load` *before* generating any recommendation. The tool's structured output anchored downstream reasoning. Hallucinated paces dropped to zero. Volume hallucinations dropped a lot but not entirely.

**Lesson:** ordering matters. Even good tools get ignored if the prompt doesn't make calling them the first step.

### v2: Decision rules in the prompt, not just "use your judgment"

Explicit table: `acwr_status` → action. `flags present` → action. Plan deviation > X% → escalate. The model started producing consistent week-to-week behavior, which is what I actually wanted.

**Lesson:** LLMs are great at applying rules, mediocre at inventing them. Encode the rules.

### v3: Output schema enforcement

Specified the calendar event JSON shape and the summary email structure. Asked for valid JSON in a fenced block, then parse separately. Calendar push failure rate went from ~30% (malformed events) to <5%.

**Lesson:** structure the output the way you'd structure an API response. Don't leave parsing to vibes.

### v4: Memory via history/ files

Each weekly run writes a `history/YYYY-MM-DD.md` summary. Next week's run reads the last 4. This gives the agent enough context to notice multi-week patterns ("you've deloaded twice in a row, something's up") without dumping the entire activity log into the prompt.

**Lesson:** rolling summaries beat full history. Tokens spent on yesterday's commentary are tokens not spent on this week's plan.

### v7 (current): First-run wizard branch in the prompt itself

Once we made the source repo public and the Deploy button viable for non-technical users, the first-run experience became a real problem: a fresh fork ships `agent/plan.md` as a template full of `<your_*>` placeholders, and the user has no way to know how to fill it short of reading the schema themselves. Solved by adding a *first-run wizard* branch at the very top of the prompt:

- The prompt's first action is to check `agent/plan.md` for `<your_*>` placeholder strings.
- If found, it switches into wizard mode: asks the user 9 questions (name, timezone, race details, current mileage, easy pace, recent 5K, max HR, injuries, default times) in a single consolidated message, then generates the filled `agent/plan.md` from their answers — including a phase split and a week-by-week skeleton scaled to the race date — and stops without trying to do a weekly review (no Strava history to analyze on a fresh install).
- If no placeholders are found, the prompt proceeds straight into the weekly review as before.

This collapses what used to be "edit 200 lines of YAML by hand" into a single chat exchange — and crucially, it's the *same prompt* doing both jobs, so the scheduled task that runs Sunday 8pm can be either "first install" or "week 47 of training" depending on plan.md state.

**Lesson:** for a self-deploying agent, the prompt's job is to detect the install state and branch on it. If the first-week prompt and the weekly-review prompt were separate, the user would have to pick which to invoke — and the scheduled task wouldn't know either. Branching in the prompt itself keeps the entry point singular.

### v6: Athlete preferences as a config block, not chat instructions

The first end-to-end calendar push made it obvious that "what time are workouts" and "do I want mobility as its own event" are athlete preferences, not training prescription — and they shouldn't live in chat (gets forgotten next week) or in the prompt body (per-athlete config doesn't belong in shared logic). Added a `## Preferences` block at the top of `plan.md`:

```yaml
default_run_time: "06:30"
default_strength_time: "06:30"
default_mobility_time: "19:30"
mobility_delivery: separate_event       # vs "in_run_description"
default_calendar: primary
notification_method: popup              # popup = in-device push; email = Calendar email
notification_minutes_before: 30
suppress_email_notifications: true
race_week_overrides:
  long_run_time: "07:00"
```

The mobility piece also surfaced an equipment-vs-bodyweight split inside the ATG menu: half the "mobility day" exercises in the PDF need an incline / DB / barbell and don't belong in an evening event the athlete does on the living-room floor. `kot.md` now splits the pool into `mobility_home` (bodyweight) and `mobility_gym` (needs gear); the prompt always pulls from `mobility_home` when emitting standalone evening mobility events.

The prompt now reads these defaults and uses them for the calendar event JSON. `mobility_delivery: separate_event` makes `mobility_midweek` / `mobility_weekend` their own afternoon events instead of folded into the morning run's description.

**Lesson:** anything the athlete might want to change without touching the prescription belongs in a config block, not the prompt and not chat. The prompt's job is to read it and apply; the athlete's job is to edit one line. Keeps the prompt stable across athletes / weeks / preferences.

### v5: Full ATG content, compressed into Tue/Thu

The original prompt pinned KOT to Tuesday and Thursday with a small handful of bodyweight exercises. The athlete's actual strength source is the full ATG (Knees Over Toes / Ben Patrick) program — but the schedule still lives on Tue/Thu, not the PDF's native 5 days. So the rewrite kept the days fixed and instead compressed the ATG content:

- **`kot_a` (Tue)** and **`kot_b` (Thu)** are now full-body sessions (~45–60 min each) that fold the high-yield lower-body work *and* upper push / pull / rotator-cuff in for healthspan.
- The PDF's standalone Wed mobility-day content gets pulled out into `mobility_midweek` (~10 min Wed), `mobility_weekend` (~15 min Sat or Sun), and an always-optional `mobility_daily` snack pool.

The prompt's source-of-truth bullet points at `kot.md` for the menu; the plan-constraint section pins the days, requires no strength + quality on the same day, and excludes strength from the day before a long run, race day, and the two days before race day. Mobility snacks live in the calendar event *description*, never as their own blocking event.

**Lesson:** The prompt's job is to encode the *constraints* (what can't violate), not the *menu* (what's available). When the strength program grew in content but stayed fixed in days, the prompt didn't need to enumerate every exercise — it just needed to pin the days, name the constraints, and point at `kot.md` for everything else. The menu can be edited in `kot.md` without touching the prompt.

## Decision rules

These live verbatim in the prompt. They're load-bearing.

```
1. Call analyze_training_load(weeks=4) first. Always.

2. Map acwr_status to base action:
   - undertraining (ACWR < 0.8) → progress (up to +10% volume)
   - optimal (0.8-1.3)         → execute as planned
   - threshold (1.3-1.5)       → execute but don't progress
   - danger (>1.5)             → deload 20-30%, swap one quality session for easy

3. Override base action if any flag is present:
   - elevated_hr_drift_3_of_last_4 → deload regardless of ACWR
   - missed_long_run_2_consecutive → repeat last week, don't progress
   - resting_hr_elevated_7d        → deload 15%
   - completion_rate < 60%         → repeat last week, surface in email

4. Apply plan constraints:
   - Never schedule quality work on consecutive days
   - Strength (KOT) on Tuesday and Thursday only
   - No strength on day-before-long-run

5. Escalate to me (don't auto-adjust) if:
   - ACWR > 1.7
   - Two consecutive flag-triggered deloads
   - Plan completion < 40% over 2 weeks
   - Anything the rules don't cover

6. Write calendar events with:
   - Title: "[Workout type] — [headline number]"
     ("Tempo — 4mi @ 7:30", not "Tempo Run Week 6 Session 2")
   - Description: full prescription + KOT block if strength day
   - Start time: respect timezone in plan.md
```

## Output contracts

The agent emits two things, both structured:

**Calendar events** (one JSON array, parsed by the orchestration code):
```json
[
  {
    "date": "2026-05-13",
    "title": "Tempo — 4mi @ 7:30",
    "description": "Warm up 10 min easy. 4 miles at 7:30/mi. Cool down 10 min easy. Strength: KOT split squat 3x10, tib raises 3x20, backward sled 3x40m.",
    "start_local": "06:30",
    "duration_min": 55,
    "calendar": "primary"
  }
]
```

**Summary email** (markdown):
```
## Week of May 13

**Last week status:** ACWR 1.06 (optimal). 4/4 runs completed. Long run pace
was 12s/mi faster than target with HR in range — absorbing the load well.

**This week's plan:**
- Tue: Tempo — 4mi @ 7:30 + KOT
- Thu: Easy — 5mi + KOT
- Sat: Easy — 4mi
- Sun: Long — 11mi @ easy effort

**Adjustments from plan:** Long run bumped 1mi from plan baseline of 10mi
since last week's 10 felt easy and ACWR has headroom. KOT exercises rotated
to emphasize posterior chain — overdue.

**Watch:** HR drift on Thursday tempo was 5%. Not a flag yet but on my radar.
```

## Known prompt limitations

- **Pace targets in mixed units** — the agent occasionally mixes min/km and min/mi when my plan and Strava data disagree. Mitigation: explicit unit in plan.md, agent told to convert to my preferred display unit.
- **First week of a new plan** — no history to draw on. Currently the agent leans heavily on plan.md and ignores my fitness baseline. Probably fine. Will revisit if a goal change makes it matter.
- **Race week** — taper logic is not in the rules above. Need to add. For now I escalate manually 3 weeks out.
- **Injury reports from me** — there's no structured way for me to say "knee tweaked, please be careful Thursday." Currently I write a free-text note in plan.md and the agent reads it. This is fragile. Probably needs a `set_athlete_note` tool eventually.
