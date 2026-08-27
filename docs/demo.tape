Output docs/demo.gif
Require foreman
Require bash
Set Shell "bash"
Set FontSize 13
Set Width 1280
Set Height 760
Set Theme "Catppuccin Macchiato"
Set Padding 18
Set WindowBar Colorful
Set WindowBarSize 28
Set BorderRadius 12
Set Framerate 30
Set TypingSpeed 18ms
Set CursorBlink false
Set LetterSpacing 0.5

Type "clear" Sleep 200ms Enter
Sleep 400ms

Type "foreman --version && echo '  — multi-model orchestration v0.3.1'" Sleep 300ms Enter
Sleep 900ms

Type "foreman doctor" Sleep 300ms Enter
Sleep 1600ms

Type "rm -rf /tmp/foreman-macos-demo && mkdir -p /tmp/foreman-macos-demo && cd /tmp/foreman-macos-demo && foreman init --name macos-demo 2>&1 | head -20" Sleep 300ms Enter
Sleep 1400ms

Type "foreman agents" Sleep 300ms Enter
Sleep 1300ms

Type "foreman ticket hello --title 'Hello world'" Sleep 300ms Enter
Sleep 800ms

Type "ls -R .foreman 2>&1 | head -30" Sleep 300ms Enter
Sleep 900ms

Type "foreman status" Sleep 300ms Enter
Sleep 900ms

Type "foreman cost --by tier 2>&1 | head -20" Sleep 300ms Enter
Sleep 900ms

Type "foreman --help | head -24" Sleep 300ms Enter
Sleep 1200ms
