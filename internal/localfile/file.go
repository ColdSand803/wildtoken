// Package localfile preserves user files while publishing CLI changes.
package localfile

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const MaxBytes = 16 << 20

type Snapshot struct {
	Path      string
	Data      []byte
	requested string
	exists    bool
}

func Expand(path string) (string, error) {
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		if path == "~" {
			path = home
		} else {
			path = filepath.Join(home, strings.TrimPrefix(path, "~/"))
		}
	}
	return filepath.Abs(path)
}

// Resolve follows existing links, including linked parent directories. A
// dangling link is refused instead of being replaced with an ordinary file.
func Resolve(path string) (string, error) {
	absolute, err := Expand(path)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(absolute); err == nil {
		return filepath.EvalSymlinks(absolute)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	parent := filepath.Dir(absolute)
	if parent == absolute {
		return absolute, nil
	}
	resolved, err := Resolve(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(absolute)), nil
}

func Read(path string) (Snapshot, error) {
	requested, err := Expand(path)
	if err != nil {
		return Snapshot{}, err
	}
	resolved, err := Resolve(requested)
	if err != nil {
		return Snapshot{}, err
	}
	s := Snapshot{Path: resolved, requested: requested}
	file, err := os.Open(resolved)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return s, err
	}
	if !info.Mode().IsRegular() {
		return s, fmt.Errorf("not a regular file: %s", resolved)
	}
	s.Data, err = io.ReadAll(io.LimitReader(file, MaxBytes+1))
	if err != nil {
		return s, err
	}
	if len(s.Data) > MaxBytes {
		return s, fmt.Errorf("file exceeds 16 MiB: %s", resolved)
	}
	s.exists = true
	return s, nil
}

func (s Snapshot) Exists() bool   { return s.exists }
func (s Snapshot) Digest() string { sum := sha256.Sum256(s.Data); return hex.EncodeToString(sum[:]) }

func writeTemp(dir, pattern string, data []byte) (string, error) {
	file, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return "", err
	}
	name := file.Name()
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(name)
		return "", err
	}
	return name, nil
}

// Apply checks for edits since the preview, backs up the old bytes and replaces
// the resolved target atomically. The original symlink remains untouched.
func (s Snapshot) Apply(next []byte) (string, error) {
	resolved, err := Resolve(s.requested)
	if err != nil {
		return "", err
	}
	if resolved != s.Path {
		return "", errors.New("symlink changed after preview")
	}
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil {
		return "", err
	}
	lockPath := s.Path + ".wildtokenctl.lock"
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", fmt.Errorf("configuration is locked: %w", err)
	}
	lock.Close()
	defer os.Remove(lockPath)
	current, err := Read(s.requested)
	if err != nil {
		return "", err
	}
	if current.Path != s.Path || current.exists != s.exists || !bytes.Equal(current.Data, s.Data) {
		return "", errors.New("file or symlink changed after preview; generate a new plan")
	}
	if s.exists && bytes.Equal(s.Data, next) {
		return "", nil
	}
	var backup string
	if s.exists {
		backup, err = writeTemp(filepath.Dir(s.Path), filepath.Base(s.Path)+".backup-*", s.Data)
		if err != nil {
			return "", err
		}
	}
	temporary, err := writeTemp(filepath.Dir(s.Path), ".wildtokenctl-*", next)
	if err != nil {
		return backup, err
	}
	defer os.Remove(temporary)
	if !s.exists {
		// No-replace publication also catches a file created by another writer.
		err = os.Link(temporary, s.Path)
	} else {
		err = os.Rename(temporary, s.Path)
	}
	if err != nil {
		return backup, err
	}
	if dir, err := os.Open(filepath.Dir(s.Path)); err == nil {
		dir.Sync()
		dir.Close()
	}
	return backup, nil
}

func Create(path string, data []byte) error {
	s, err := Read(path)
	if err != nil {
		return err
	}
	if s.Exists() {
		return fmt.Errorf("refusing to overwrite %s", s.Path)
	}
	_, err = s.Apply(data)
	return err
}
