Output docs/demo.gif
Require foreman
Require bash
Set Shell "bash"
Set FontSize 13
Set Width 1320
Set Height 820
Set Theme "Catppuccin Macchiato"
Set Padding 16
Set WindowBar Colorful
Set WindowBarSize 28
Set BorderRadius 12
Set Framerate 30
Set TypingSpeed 16ms
Set CursorBlink false

Type "clear" Sleep 200ms Enter
Sleep 800ms

Type "foreman --version" Sleep 250ms Enter
Sleep 1200ms

Type "foreman doctor" Sleep 250ms Enter
Sleep 1800ms

Type "foreman --help | head -28" Sleep 250ms Enter
Sleep 1400ms

Type "rm -rf /tmp/foreman-tour && mkdir -p /tmp/foreman-tour && cd /tmp/foreman-tour && foreman init --name tour 2>&1 | head -16" Sleep 250ms Enter
Sleep 1800ms

Type "foreman agents" Sleep 250ms Enter
Sleep 1500ms

Type "cat .foreman/foreman.json | head -30" Sleep 250ms Enter
Sleep 1300ms

Type "foreman models 2>&1 | head -20" Sleep 250ms Enter
Sleep 1300ms

Type "foreman ticket api --title 'Add REST API' && foreman ticket test --title 'Write tests' --parent T001 && ls -1 .foreman/tickets/" Sleep 250ms Enter
Sleep 1500ms

Type "cat .foreman/tickets/T001-api.md | head -28" Sleep 250ms Enter
Sleep 1300ms

Type "foreman status" Sleep 250ms Enter
Sleep 1300ms

Type "foreman cost --by tier 2>&1 | head -16" Sleep 250ms Enter
Sleep 1200ms

Type "foreman cost --by agent 2>&1 | head -16" Sleep 250ms Enter
Sleep 1200ms

Type "foreman cost --by model 2>&1 | head -16" Sleep 250ms Enter
Sleep 1200ms

Type "foreman verify --help; echo '---'; foreman run --help | head -12" Sleep 250ms Enter
Sleep 1300ms

Type "foreman work --help | head -14; echo '---'; foreman queue --help | head -8" Sleep 250ms Enter
Sleep 1300ms

Type "foreman ask --help | head -10; echo '---'; foreman note --help | head -6" Sleep 250ms Enter
Sleep 1200ms

Type "foreman report --help; echo '---'; foreman tail --help | head -6; echo '---'; foreman diff 2>&1 | head -12" Sleep 250ms Enter
Sleep 1400ms

Type "ls -R .foreman 2>&1 | head -40" Sleep 250ms Enter
Sleep 1200ms

Type "echo 'Dashboard: foreman ui --once (one frame)' && foreman ui --once 2>&1 | head -60" Sleep 250ms Enter
Sleep 1800ms

Type "echo 'Every command: init, agents, models, ticket, status, cost, verify, run, work, queue, ask, note, report, tail, diff, ui, doctor, version'" Sleep 250ms Enter
Sleep 1500ms
