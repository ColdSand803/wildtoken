//go:build darwin && desktop

package driver

import (
	"fmt"

	"fyne.io/systray"
)

type Action int

const (
	OpenConsole Action = iota
	CopyEndpoint
	ShowLog
	ShowData
	Exit
)

// Run owns AppKit's main loop. The caller must invoke it on the main thread.
func Run(icon []byte, port uint16, onReady func(), onAction func(Action), onExit func()) {
	stopped := make(chan struct{})
	defer close(stopped)
	systray.Run(func() {
		systray.SetIcon(icon)
		systray.SetTooltip(fmt.Sprintf("WildToken :%d", port))
		status := systray.AddMenuItem(fmt.Sprintf("运行中 · 端口 %d", port), "")
		status.Disable()
		systray.AddSeparator()
		console := systray.AddMenuItem("打开管理后台", "")
		copy := systray.AddMenuItem("复制 API 地址", "")
		logs := systray.AddMenuItem("查看运行日志", "")
		data := systray.AddMenuItem("打开数据目录", "")
		systray.AddSeparator()
		quit := systray.AddMenuItem("退出", "等待请求和日志写入结束")
		onReady()
		go func() {
			for {
				select {
				case <-stopped:
					return
				case <-console.ClickedCh:
					onAction(OpenConsole)
				case <-copy.ClickedCh:
					onAction(CopyEndpoint)
				case <-logs.ClickedCh:
					onAction(ShowLog)
				case <-data.ClickedCh:
					onAction(ShowData)
				case <-quit.ClickedCh:
					status.SetTitle("正在退出，等待请求结束…")
					quit.Disable()
					onAction(Exit)
				}
			}
		}()
	}, onExit)
}

// Quit is called only once the gateway has drained, after onReady.
func Quit() { systray.Quit() }
