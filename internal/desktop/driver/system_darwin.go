//go:build darwin && desktop

package driver

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

func command(name string, input string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	if input != "" {
		cmd.Stdin = strings.NewReader(input)
	}
	return cmd.Run()
}

func OpenURL(url string) error { return command("/usr/bin/open", "", url) }

func OpenDirectory(path string) error { return command("/usr/bin/open", "", path) }

func OpenLog(path string) error { return command("/usr/bin/open", "", "-a", "Console", path) }

func CopyText(text string) error { return command("/usr/bin/pbcopy", text) }

// The message is an argument, not AppleScript source.
func Alert(message string) error {
	const script = `on run argv
    display alert "WildToken" message (item 1 of argv) as critical buttons {"确定"} default button 1
end run`
	return exec.Command("/usr/bin/osascript", "-e", script, message).Run()
}
