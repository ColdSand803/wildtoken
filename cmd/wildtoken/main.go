// Command wildtoken runs the WildToken gateway.
//
// On Linux and macOS it is a foreground console server. On Windows it defaults
// to a system tray application with no console window; set WILDTOKEN_NO_TRAY=1
// or pass --no-tray / --console for headless and CI use.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/liguangsheng/wildtoken/internal/app"
)

func main() {
	if runTray() {
		return
	}
	os.Exit(runServer(false))
}

// runServer starts the gateway and blocks until it stops. It returns the
// process exit code.
func runServer(logToFile bool) int {
	initLogging(logToFile)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	server, err := app.New(ctx)
	if err != nil {
		slog.Error("WildToken failed to start", "error", err)
		return 1
	}

	if err := server.Serve(ctx); err != nil {
		slog.Error("WildToken exited with error", "error", err)
		return 1
	}
	return 0
}

// initLogging sends output to stdout, or to wildtoken.log when no console is
// attached.
func initLogging(logToFile bool) {
	level := slog.LevelInfo
	if value := os.Getenv("WILDTOKEN_LOG"); value != "" {
		if err := level.UnmarshalText([]byte(value)); err != nil {
			level = slog.LevelInfo
		}
	}
	options := &slog.HandlerOptions{Level: level}

	if !logToFile {
		slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, options)))
		return
	}

	file, err := os.OpenFile("wildtoken.log", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		// Fall back to stdout, which may be discarded without a console.
		slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, options)))
		slog.Error("failed to open wildtoken.log; falling back to stdout", "error", err)
		return
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(file, options)))
}
