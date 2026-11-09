//go:build darwin && desktop

package desktop

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/liguangsheng/wildtoken/internal/app"
	"github.com/liguangsheng/wildtoken/internal/desktop/driver"
)

// Run launches the bundled application. --console and backup retain its data
// directory but do not start AppKit.
func Run(args []string, icon []byte) int {
	console := consoleRequested(args, os.Getenv)
	fail := func(err error, logPath string) int {
		slog.Error("WildToken desktop failed", "error", err)
		if !console {
			message := fmt.Sprintf("WildToken 无法运行：\n%v", err)
			if logPath != "" {
				message += "\n\n运行日志：" + logPath
			}
			if alertErr := driver.Alert(message); alertErr != nil {
				slog.Error("could not show the startup error", "error", alertErr)
			}
		}
		return 1
	}

	executable, err := os.Executable()
	if err != nil {
		return fail(err, "")
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return fail(err, "")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fail(err, "")
	}
	paths, err := bundlePaths(executable, home)
	if err != nil {
		return fail(err, "")
	}
	if err := paths.prepare(); err != nil {
		return fail(err, "")
	}
	logFile, err := os.OpenFile(paths.log, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fail(err, "")
	}
	defer logFile.Close()
	var output io.Writer = logFile
	if console {
		output = io.MultiWriter(logFile, os.Stdout)
	}
	var level slog.LevelVar
	slog.SetDefault(slog.New(slog.NewTextHandler(output, &slog.HandlerOptions{Level: &level})))
	settings, err := paths.loadSettings()
	if err != nil {
		return fail(err, paths.log)
	}
	if value := os.Getenv("WILDTOKEN_LOG"); value != "" {
		var parsed slog.Level
		if parsed.UnmarshalText([]byte(value)) == nil {
			level.Set(parsed)
		}
	}

	if len(args) > 0 && args[0] == "backup" {
		path, err := app.BackupNow(context.Background())
		if err != nil {
			return fail(err, paths.log)
		}
		slog.Info("backup written", "path", path)
		return 0
	}
	lock, err := driver.Lock(filepath.Join(paths.data, ".instance.lock"))
	if err != nil {
		return fail(err, paths.log)
	}
	defer lock.Close()

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server, err := app.NewWithSettings(ctx, settings)
	if err != nil {
		return fail(err, paths.log)
	}
	var serveErr error
	done := make(chan struct{})
	go func() {
		serveErr = server.Serve(ctx)
		close(done)
	}()
	shutdown := func() { cancel(); <-done }
	defer shutdown()

	if !console {
		ready := make(chan struct{})
		go func() {
			<-ready
			<-done
			driver.Quit()
		}()
		driver.Run(icon, server.Ready.Port, func() {
			slog.Info("WildToken menu ready", "admin_url", server.Ready.AdminURL, "data_dir", paths.data)
			close(ready)
		}, func(action driver.Action) {
			var err error
			switch action {
			case driver.OpenConsole:
				err = driver.OpenURL(server.Ready.AdminURL)
			case driver.CopyEndpoint:
				err = driver.CopyText(strings.TrimSuffix(server.Ready.AdminURL, "/console") + "/v1")
			case driver.ShowLog:
				err = driver.OpenLog(paths.log)
			case driver.ShowData:
				err = driver.OpenDirectory(paths.data)
			case driver.Exit:
				cancel()
			}
			if err != nil {
				slog.Error("desktop action failed", "error", err)
				driver.Alert("操作失败：" + err.Error())
			}
		}, shutdown)
		shutdown()
	}
	<-done
	if serveErr != nil {
		return fail(serveErr, paths.log)
	}
	return 0
}
