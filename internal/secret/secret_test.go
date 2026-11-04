package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func mustNew(t *testing.T, passphrase string) *Cipher {
	t.Helper()
	c, err := New(passphrase)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestASealedValueOpensBackAndNeverRepeats(t *testing.T) {
	c := mustNew(t, "passphrase")

	first, err := c.Seal("sk-live-123")
	if err != nil {
		t.Fatal(err)
	}
	second, _ := c.Seal("sk-live-123")
	if !IsSealed(first) || first == second {
		t.Fatalf("sealed %q and %q: want prefixed and distinct", first, second)
	}

	plain, err := c.Open(first)
	if err != nil || plain != "sk-live-123" {
		t.Fatalf("open = %q, %v", plain, err)
	}
}

func TestAnotherKeyCannotOpenIt(t *testing.T) {
	sealed, _ := mustNew(t, "right").Seal("sk-live-123")
	if _, err := mustNew(t, "wrong").Open(sealed); !errors.Is(err, ErrWrongKey) {
		t.Fatalf("err = %v, want ErrWrongKey", err)
	}
}

func TestAnEmptyValueStaysEmpty(t *testing.T) {
	c := mustNew(t, "passphrase")
	if sealed, _ := c.Seal(""); sealed != "" {
		t.Errorf("seal(\"\") = %q", sealed)
	}
	if plain, err := c.Open(""); plain != "" || err != nil {
		t.Errorf("open(\"\") = %q, %v", plain, err)
	}
}

// faketoken stores base64(nonce ‖ ciphertext) under sha256(ENCRYPTION_KEY)
// with no associated data; with the prefix added it opens here unchanged.
func TestAFaketokenValueOpensWithThePrefixAdded(t *testing.T) {
	key := sha256.Sum256([]byte("shared passphrase"))
	block, _ := aes.NewCipher(key[:])
	aead, _ := cipher.NewGCM(block)
	nonce := make([]byte, aead.NonceSize())
	rand.Read(nonce)
	faketoken := base64.StdEncoding.EncodeToString(aead.Seal(nonce, nonce, []byte("sk-upstream"), nil))

	plain, err := mustNew(t, "shared passphrase").Open(prefix + faketoken)
	if err != nil || plain != "sk-upstream" {
		t.Fatalf("open = %q, %v", plain, err)
	}
}

func TestAKeyFileIsCreatedOnceAndReadBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wildtoken.key")

	if _, ok, err := ReadKeyFile(path); ok || err != nil {
		t.Fatalf("missing file: ok=%v err=%v", ok, err)
	}

	created, err := CreateKeyFile(path)
	if err != nil || len(created) != 64 {
		t.Fatalf("create = %q, %v", created, err)
	}
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
			t.Errorf("mode = %v, want 0600", info.Mode().Perm())
		}
	}

	read, ok, err := ReadKeyFile(path)
	if !ok || err != nil || read != created {
		t.Fatalf("read = %q ok=%v err=%v, want the created key", read, ok, err)
	}
	if _, err := CreateKeyFile(path); err == nil {
		t.Error("a second create replaced the key file")
	}
}

// An empty file is refused rather than read as missing, which would let a new
// key replace the one that sealed the stored values.
func TestAnEmptyKeyFileIsRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wildtoken.key")
	os.WriteFile(path, []byte("\n"), 0o600)

	if _, ok, err := ReadKeyFile(path); ok || err == nil {
		t.Fatalf("ok=%v err=%v, want a refusal", ok, err)
	}
}

func TestAnOpenKeyFileLosesGroupAndWorldAccess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no POSIX modes")
	}
	path := filepath.Join(t.TempDir(), "wildtoken.key")
	os.WriteFile(path, []byte("passphrase\n"), 0o644)

	if _, _, err := ReadKeyFile(path); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", info.Mode().Perm())
	}
}
