# Prompt Design

The agent's job description lives in [`agent/prompt.md`](./agent/prompt.md).
That file is the source of truth — this doc is the iteration log for
non-obvious decisions made along the way. Read the prompt first; come back
here for the *why*.

## The job

Every Sunday evening: review the past 7 days against `agent/plan.md`,
decide what next week should look like, write it to Google Calendar,
summarize choices in a history file committed back to the repo.

## Structural decisions made at scaffold time (v0)

These aren't iterations — they were design choices in the original prompt
scaffold, made before any model output was generated. Documented here
because they're load-bearing and a reader of the prompt should know why
they're there:

- **Tool-first sequence.** The prompt requires `analyze_training_load` to
  be called before any recommendation is generated. Without this anchor,
  there's no shared ground truth for "how is training going?" — the
  agent would invent a load story per run.
- **Decision rules in the prompt body, not in "use your judgment."** The
  prompt has explicit `acwr_status → action` and `flag → action` mappings.
  LLMs apply rules consistently; they invent them inconsistently. The
  inventing happens once, when the rule gets written; the applying happens
  weekly.
- **Output as structured JSON, not prose.** The calendar events are a
  fenced JSON code block matching a fixed shape, parsed by the calendar
  push step. The summary email is the only freeform output.
- **Cross-week memory via history files.** Each weekly run writes a
  `history/<sunday-date>.md` summary. The next run reads the most recent
  3–4 of them. This gives the agent enough context to notice multi-week
  patterns ("you've deloaded twice in a row, something's up") without
  dumping raw activity logs into the prompt.

## Iterations during the build

### v1 (2026-05-14): Full ATG strength content, compressed into Tue/Thu

Original prompt pinned KOT to Tuesday and Thursday with a small handful of
bodyweight exercises. The athlete actually wanted the *full* KOT/ATG
program (knee-dominant lower + posterior chain + upper-body push for
healthspan) — but with the schedule still on Tue/Thu, not the source's
native 5 days, because running has to fit alongside.

- **`kot_a` (Tue)** and **`kot_b` (Thu)** became full-body sessions
  (~45–60 min each) folding the highest-yield lower work + upper push/pull
  + rotator-cuff into the two days.
- The standalone Wednesday mobility-day content from the source was pulled
  out into `mobility_midweek` (Wed, ~10 min), `mobility_weekend`
  (Sat, ~15 min), and an always-optional `mobility_daily` snack pool.

The prompt's *plan constraints* section pins the days, requires no strength
on a quality-run day, and excludes strength from the day before a long
run, race day, and the two days before race day. Mobility snacks live in
the calendar event *description*, never as their own blocking event
(later relaxed in v3).

**Lesson:** the prompt's job is to encode the *constraints* (what can't be
violated), not the *menu* (what's available). When the strength program
grew in content but stayed fixed in days, the prompt didn't need to
enumerate every exercise — it just needed to pin the days, name the
constraints, and point at `kot.md` for everything else. The menu can be
edited in `kot.md` without touching the prompt.

### v2 (2026-05-14): Athlete preferences as a config block, not chat instructions

The first end-to-end calendar push made it obvious that "what time are
workouts" and "do I want mobility as its own event" are *athlete
preferences*, not training prescription — and they shouldn't live in chat
(gets forgotten next week) or in the prompt body (per-athlete config
doesn't belong in shared logic). Added a `## Preferences` block at the top
of `agent/plan.md`:

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

The prompt reads these for the calendar event JSON. `mobility_delivery:
separate_event` makes `mobility_midweek` / `mobility_weekend` their own
events instead of folded into the morning run's description (overriding
the v1 default).

While building this, a related discovery: the source's mobility menu has
two equipment classes — half need an incline / DB / barbell. Those don't
belong in an evening event the athlete does on the living-room floor.
`kot.md` now splits the pool into `mobility_home` (bodyweight, TV-friendly)
and `mobility_gym` (needs gear). The prompt pulls from `mobility_home`
only when emitting standalone evening events.

**Lesson:** anything the athlete might want to change without touching the
prescription belongs in a config block, not the prompt and not chat. The
prompt's job is to read it and apply; the athlete's job is to edit one
line.

### v3 (2026-05-15): First-run wizard branch in the prompt itself

Once the source repo became publicly forkable, the first-run experience
became a real problem: a fresh fork ships `agent/plan.md` as a template
full of `<your_*>` placeholders, and the user has no obvious path to fill
it short of reading the schema themselves. Solution: branch on plan-state
at the top of the prompt.

- First action on each run is to check `agent/plan.md` for `<your_*>`
  placeholders.
- If found → **wizard mode**: ask the user 9 questions (name, timezone,
  race details, current mileage, easy pace, recent 5K, max HR, injuries,
  default times) in a single consolidated message; from the answers,
  generate the filled plan.md including a phase split and a week-by-week
  skeleton scaled to the race date; stop without trying the weekly review
  (no Strava history to analyze on a fresh install).
- If no placeholders → straight to the weekly review.

**Lesson:** for a self-deploying agent, the prompt's job is to detect the
install state and branch on it. If the first-week prompt and the
weekly-review prompt were separate, the user would have to pick which to
invoke — and the scheduled task wouldn't know either. Branching in the
prompt itself keeps the entry point singular.

## What the prompt produces

Two outputs, both required, in this order:

**Calendar events** — one fenced JSON array, parsed by the calendar push
step. Shape:

```json
[
  {
    "date": "YYYY-MM-DD",
    "title": "Type — headline number",
    "description": "Full prescription, with pace + HR + RPE for runs",
    "start_local": "HH:MM",
    "duration_min": 0,
    "calendar": "primary"
  }
]
```

Title rules: scannable from a calendar grid. *"Tempo — 4mi @ 7:30"* yes.
*"Tempo Run Week 6 Session 2 Mid-Cycle Build Phase"* no.

**Summary email** — freeform markdown. The agent also writes this same
summary to `agent/history/<sunday-date>.md` and commits it.

Exact rules and the summary template live verbatim in
[`agent/prompt.md`](./agent/prompt.md) — don't re-derive them here, that's
how docs drift from code.
