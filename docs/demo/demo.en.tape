# English version：record.sh starts omp (left) and the mock server (right) in tmux first; this tape only attaches and replays the typing.
Output "demo.en.gif"
Require tmux

Set Shell "bash"
Set FontFamily "Sarasa Mono SC"
Set FontSize 15
Set Width 1280
Set Height 540
Set Padding 8
Set Framerate 15
Set TypingSpeed 55ms

# Attach to the tmux session (not recorded)
Hide
Type "tmux -L pii-demo attach -t demo"
Enter
Sleep 1.5s
Show

Sleep 2s
Type "Please ship the order to Michael Brandt, phone +1 415 555 0132, email michael.brandt@shopmail.com, address: 27 Willow Lane, Portland, OR 97205"
Sleep 1s
Enter
Sleep 9s
Type "/pii"
Sleep 800ms
Enter
Sleep 5s
