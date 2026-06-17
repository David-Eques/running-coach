# running-coach demo — renders docs/demo.gif
#
# Render it yourself:
#   1. printf 'cd %s\nexport PATH="$PWD/scripts:$PATH"\nexport RC_URL=https://running-coach.<you>.workers.dev\nexport RC_TOKEN=<your-bearer>\n' "$PWD" > /tmp/rc_demo_env
#   2. vhs docs/demo.tape
# The bearer never lives in this committed file — it's sourced from /tmp/rc_demo_env at render time.

Output docs/demo.gif

Set Shell "bash"
Set FontSize 17
Set Width 1180
Set Height 820
Set Padding 22
Set Theme "Catppuccin Mocha"
Set TypingSpeed 28ms

Hide
Type `source /tmp/rc_demo_env && clear`
Enter
Sleep 600ms
Show

Type `# running-coach: an MCP that returns a coach's read of your week, not raw Strava JSON.`
Sleep 400ms
Enter
Sleep 1000ms

Type `# "How is my training load?"  ->  deterministic analytics, computed live in src/analyze.ts`
Sleep 400ms
Enter
Sleep 600ms
Type `rc analyze_training_load '{"weeks":4}'`
Sleep 300ms
Enter
Sleep 2600ms

Type `# "Run Wednesday's tempo as planned?"  ->  the deload/progress rules live in code, not the prompt`
Sleep 400ms
Enter
Sleep 600ms
Type `rc suggest_next_workout '{"plan_phase":"Marathon base, wk5/12","target_workout":"Tempo 5mi @ MP","day_of_week":"Wednesday"}'`
Sleep 300ms
Enter
Sleep 2800ms

Type `# The agent turns these into next week's calendar. The math is here: versioned, tested, deterministic.`
Sleep 400ms
Enter
Sleep 2200ms
