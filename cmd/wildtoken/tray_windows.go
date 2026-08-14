//go:build windows

package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"

	"fyne.io/systray"

	"github.com/liguangsheng/wildtoken/internal/app"
)

// runTray starts the tray UI with a background HTTP server, unless the operator
// asked for a plain console server.
//
// It reports whether it handled the process; false means main should fall
// through to the ordinary server path.
func runTray() bool {
	if forceServerMode() {
		// There is no console under the windowsgui subsystem, so logs go to a file.
		os.Exit(runServer(true))
	}

	initLogging(true)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	server, err := app.New(ctx)
	if err != nil {
		slog.Error("WildToken failed to start", "error", err)
		os.Exit(1)
	}
	ready := server.Ready

	var serverDone sync.WaitGroup
	serverDone.Add(1)
	go func() {
		defer serverDone.Done()
		if err := server.Serve(ctx); err != nil {
			slog.Error("WildToken server failed", "error", err)
		}
	}()

	systray.Run(func() {
		systray.SetIcon(trayIconPNG)
		systray.SetTitle("WildToken")
		systray.SetTooltip(fmt.Sprintf("WildToken :%d", ready.Port))

		openItem := systray.AddMenuItem("打开管理后台", "")
		quitItem := systray.AddMenuItem("退出", "")

		slog.Info("WildToken tray ready", "port", ready.Port, "admin_url", ready.AdminURL)

		go func() {
			for {
				select {
				case <-openItem.ClickedCh:
					openAdmin(ready.AdminURL)
				case <-quitItem.ClickedCh:
					slog.Info("quit requested from tray")
					systray.Quit()
					return
				}
			}
		}()
	}, func() {
		cancel()
		serverDone.Wait()
	})

	return true
}

// forceServerMode reports whether Windows should skip the tray and run a plain
// HTTP server, as CI, Docker, and debugging need.
func forceServerMode() bool {
	for _, argument := range os.Args[1:] {
		if argument == "--no-tray" || argument == "--console" {
			return true
		}
	}
	return envFlagTrue("WILDTOKEN_NO_TRAY") || envFlagTrue("WILDTOKEN_CONSOLE")
}

func envFlagTrue(name string) bool {
	value := strings.TrimSpace(os.Getenv(name))
	return value == "1" || strings.EqualFold(value, "true") || strings.EqualFold(value, "yes")
}

func openAdmin(adminURL string) {
	// rundll32 avoids the shell quoting rules that cmd /c start applies to a URL.
	command := exec.Command("rundll32", "url.dll,FileProtocolHandler", adminURL)
	if err := command.Start(); err != nil {
		slog.Error("failed to open admin URL in browser", "admin_url", adminURL, "error", err)
	}
}
