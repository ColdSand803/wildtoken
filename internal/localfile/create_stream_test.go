package localfile

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestStreamingOutputRefusesConcurrentPublication(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup")
	err := CreateWithWriter(path, func(w io.Writer) error {
		if err := os.WriteFile(path, []byte("another writer"), 0o600); err != nil {
			return err
		}
		_, err := io.WriteString(w, "download")
		return err
	})
	if err == nil {
		t.Fatal("concurrent output was replaced")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "another writer" {
		t.Fatalf("existing output changed: %q err=%v", data, err)
	}
}

func TestStreamingOutputCleansUpWriterFailure(t *testing.T) {
	dir := t.TempDir()
	err := CreateWithWriter(filepath.Join(dir, "backup"), func(w io.Writer) error {
		io.WriteString(w, "partial")
		return errors.New("download failed")
	})
	if err == nil {
		t.Fatal("failed writer was accepted")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("partial output remains: %v err=%v", entries, err)
	}
}
