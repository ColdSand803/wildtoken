package localfile

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func put(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestApplyPreservesSymlinkAndBacksUpExactBytes(t *testing.T) {
	dir := t.TempDir()
	target, link := filepath.Join(dir, "real.jsonc"), filepath.Join(dir, "models.json")
	put(t, target, "// original\n{}\n")
	if err := os.Symlink("real.jsonc", link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("symlink privilege unavailable")
		}
		t.Fatal(err)
	}
	snapshot, err := Read(link)
	if err != nil {
		t.Fatal(err)
	}
	backup, err := snapshot.Apply([]byte(`{"providers":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(link)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("symlink replaced")
	}
	before, _ := os.ReadFile(backup)
	if string(before) != "// original\n{}\n" {
		t.Fatalf("backup=%q", before)
	}
	after, _ := os.ReadFile(target)
	if string(after) != `{"providers":{}}` {
		t.Fatalf("target=%q", after)
	}
	if runtime.GOOS != "windows" {
		for _, path := range []string{target, backup} {
			info, _ := os.Stat(path)
			if info.Mode().Perm() != 0o600 {
				t.Errorf("permissions on %s: %o", path, info.Mode().Perm())
			}
		}
	}
}

func TestApplyRejectsEditsAfterPreviewEvenForNoop(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	put(t, path, "{}")
	snapshot, err := Read(path)
	if err != nil {
		t.Fatal(err)
	}
	put(t, path, `{"changed":true}`)
	for _, next := range []string{`{"ours":true}`, `{}`} {
		if _, err := snapshot.Apply([]byte(next)); err == nil {
			t.Fatal("overwrote a concurrent change")
		}
	}
	got, _ := os.ReadFile(path)
	if string(got) != `{"changed":true}` {
		t.Fatal("concurrent bytes changed")
	}
}

func TestCreateDoesNotOverwriteAndRejectsDanglingLinks(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "key")
	if err := Create(path, []byte("original")); err != nil {
		t.Fatal(err)
	}
	if err := Create(path, []byte("new")); err == nil {
		t.Fatal("existing file overwritten")
	}
	link := filepath.Join(dir, "dangling")
	if err := os.Symlink("missing", link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("symlink privilege unavailable")
		}
		t.Fatal(err)
	}
	if _, err := Read(link); err == nil {
		t.Fatal("dangling symlink accepted as absent file")
	}
}

func TestRetargetedSymlinkIsNotOverwritten(t *testing.T) {
	dir := t.TempDir()
	a, b, link := filepath.Join(dir, "a"), filepath.Join(dir, "b"), filepath.Join(dir, "link")
	put(t, a, "a")
	put(t, b, "b")
	if err := os.Symlink(a, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("symlink privilege unavailable")
		}
		t.Fatal(err)
	}
	snapshot, err := Read(link)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(b, link); err != nil {
		t.Fatal(err)
	}
	if _, err := snapshot.Apply([]byte("ours")); err == nil {
		t.Fatal("retargeted link accepted")
	}
	data, _ := os.ReadFile(b)
	if string(data) != "b" {
		t.Fatal("retargeted file changed")
	}
}
