//go:build !windows

package app

import (
	"log/slog"
	"os"
	"syscall"
)

// giveToDirOwner hands a backup to whoever owns its directory. Under Docker
// the service runs as root, and a backup left root-owned and owner-only in a
// host directory is one the host's user can neither read nor prune.
func giveToDirOwner(path, dir string) {
	info, err := os.Stat(dir)
	if err != nil {
		return
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return
	}
	if err := os.Chown(path, int(owner.Uid), int(owner.Gid)); err != nil {
		slog.Warn("could not give a backup to its directory's owner", "path", path, "error", err)
	}
}
