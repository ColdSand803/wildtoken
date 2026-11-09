package localfile

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// CreateWithWriter publishes a new private file only after the writer succeeds.
// It never replaces an existing file and rechecks the requested symlink path.
func CreateWithWriter(path string, write func(io.Writer) error) error {
	s, err := Read(path)
	if err != nil {
		return err
	}
	if s.Exists() {
		return fmt.Errorf("refusing to overwrite %s", s.Path)
	}
	dir := filepath.Dir(s.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".wildtokenctl-download-*")
	if err != nil {
		return err
	}
	defer func() {
		file.Close()
		os.Remove(file.Name())
	}()
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	if err := write(file); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	current, err := Read(s.requested)
	if err != nil {
		return err
	}
	if current.Path != s.Path || current.Exists() {
		return errors.New("output path changed while downloading; nothing was overwritten")
	}
	if err := os.Link(file.Name(), s.Path); err != nil {
		return err
	}
	if parent, err := os.Open(dir); err == nil {
		parent.Sync()
		parent.Close()
	}
	return nil
}
