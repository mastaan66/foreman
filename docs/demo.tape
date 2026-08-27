Output docs/demo.gif
Require foreman
Require echo
Set Shell "bash"
Set FontSize 14
Set Width 1200
Set Height 700
Set Theme "Catppuccin Mocha"
Set Padding 20
Set Framerate 30
Set TypingSpeed 30ms
Set WindowBar Colorful

Type "foreman --version"
Enter
Sleep 800

Type "foreman doctor"
Enter
Sleep 1500

Type "mkdir -p /tmp/demo && cd /tmp/demo && foreman init --name demo"
Enter
Sleep 1200

Type "foreman ticket hello --title 'Add a hello test'"
Enter
Sleep 800

Type "cat .foreman/tickets/T001-hello.md"
Enter
Sleep 1000

Type "foreman agents"
Enter
Sleep 1200

Type "foreman cost --by tier"
Enter
Sleep 1200

Type "foreman --help"
Enter
Sleep 1500
