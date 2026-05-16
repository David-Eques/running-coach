---
description: Run the weekly review and generate next week's calendar events. Invoke every Sunday evening (or schedule it weekly via claude.ai/code/scheduled).
---

# Weekly run plan

Read `agent/prompt.md` in this project and follow it exactly. That prompt is the canonical job description:

- Which MCP tools to call (`mcp__running-coach__analyze_training_load`, `mcp__running-coach__get_recent_training`, `mcp__running-coach__suggest_next_workout`) — call them in that order.
- Which files to read (`agent/plan.md` for the prescription + athlete profile + preferences, `agent/kot.md` for the strength menu, `agent/history/*.md` for prior weeks).
- Which decision rules to apply (ACWR base action + flag overrides + plan constraints + escalation thresholds).
- What to output (calendar events as a fenced JSON block + a summary markdown).

After producing the JSON, push each event to Google Calendar via the `google_calendar` connector's `create_event` tool. If you make non-trivial overrides to the plan (e.g., the load model says deload but plan.md says progress), surface the rationale clearly in the summary email AND ask the user to confirm before pushing.

If `agent/plan.md` still contains template placeholders (e.g. `<your_name>`, `<your_lthr>`), run the **first-run wizard** in `agent/prompt.md` instead of trying to plan a week — gather the athlete config interactively, write the filled version back to `agent/plan.md`, and stop. The user will run this skill again next week with a real plan in place.
