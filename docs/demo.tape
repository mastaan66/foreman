Output docs/demo.gif
Require foreman
Require bash
Set Shell "bash"
Set FontSize 13
Set Width 1280
Set Height 760
Set Theme "Catppuccin Macchiato"
Set Padding 16
Set WindowBar Colorful
Set WindowBarSize 28
Set BorderRadius 12
Set Framerate 30
Set TypingSpeed 17ms
Set CursorBlink false

Type "clear" Sleep 200ms Enter
Sleep 500ms

Type "echo '━━━ Foreman — how to use, hierarchy & memory (macOS) ━━━'" Sleep 250ms Enter
Sleep 900ms

Type "foreman --version && foreman doctor 2>&1 | head -12" Sleep 250ms Enter
Sleep 1300ms

Type "foreman agents" Sleep 250ms Enter
Sleep 1300ms

Type "echo '— Hierarchy: director -> lead (premium) -> coder/tester (standard) -> drone (economy) —'" Sleep 250ms Enter
Sleep 800ms

Type "cat .foreman/foreman.json | grep -A14 tiers | head -20" Sleep 250ms Enter
Sleep 1200ms

Type "echo '— Memory: ctxCap ctxKill maxOutPerRun per tier —'" Sleep 250ms Enter
Sleep 700ms

Type "cat docs/example-ticket.md | head -50" Sleep 250ms Enter
Sleep 1400ms

Type "foreman ticket api --title 'Add auth' --help | head -6; echo '---'; ls -1 .foreman/tickets/ | head -8" Sleep 250ms Enter
Sleep 1100ms

Type "foreman status" Sleep 250ms Enter
Sleep 1000ms

Type "foreman cost --by tier 2>&1 | head -14" Sleep 250ms Enter
Sleep 1100ms

Type "foreman cost --by agent 2>&1 | head -10" Sleep 250ms Enter
Sleep 900ms

Type "echo '— Budget enforced in run loop: checkBudget() — past ctxCap -> fresh session + checkpointBrief —'" Sleep 250ms Enter
Sleep 900ms

Type "grep -n 'checkBudget\|ctxCap\|checkpointBrief' lib.mjs | head -10" Sleep 250ms Enter
Sleep 1000ms

Type "foreman verify --help | head -6; echo '--- gates run by foreman, not worker ---'" Sleep 250ms Enter
Sleep 900ms

Type "foreman ui --once 2>&1 | head -55" Sleep 250ms Enter
Sleep 1500ms

Type "echo '✓ How to use: foreman init -> ticket <slug> -> run <id> --verify -> tail/report -> verify -> cost'" Sleep 250ms Enter
Sleep 1200ms
