//go:build darwin || linux

// Package driver contains desktop operating-system operations.
package driver

import (
	"fmt"
	"os"
	"syscall"
)

// Lock prevents two desktop instances from initializing the same database.
// Closing the returned file releases it; the lock file is never unlinked.
func Lock(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, fmt.Errorf("此数据目录已有 WildToken 实例运行：%w", err)
	}
	return file, nil
}
