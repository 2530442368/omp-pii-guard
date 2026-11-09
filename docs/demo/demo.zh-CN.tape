# 中文版：由 record.sh 先在 tmux 里起好左栏 omp、右栏模拟服务端，这里只负责连上去并回放输入。
Output "demo.zh-CN.gif"
Require tmux

Set Shell "bash"
Set FontFamily "Sarasa Mono SC"
Set FontSize 15
Set Width 1280
Set Height 540
Set Padding 8
Set Framerate 15
Set TypingSpeed 55ms

# 接入 tmux 会话（不录进画面）
Hide
Type "tmux -L pii-demo attach -t demo"
Enter
Sleep 1.5s
Show

Sleep 2s
Type "请把订单寄给张伟，手机 13812345678，邮箱 zhangwei@shopmail.cn，地址：上海市浦东新区世纪大道100号"
Sleep 1s
Enter
Sleep 9s
Type "/pii"
Sleep 800ms
Enter
Sleep 5s
