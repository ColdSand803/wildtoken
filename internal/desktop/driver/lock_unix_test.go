//go:build darwin || linux

package driver

import (
	"path/filepath"
	"testing"
)

func TestOnlyOneDesktopInstanceOwnsTheDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".instance.lock")
	first, err := Lock(path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if second, err := Lock(path); err == nil {
		second.Close()
		t.Fatal("second instance acquired the same directory")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	third, err := Lock(path)
	if err != nil {
		t.Fatalf("closed instance kept the lock: %v", err)
	}
	third.Close()
}
