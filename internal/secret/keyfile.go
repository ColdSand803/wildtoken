package secret

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// GenerateKey returns a fresh passphrase: 32 random bytes in hex, the form
// `openssl rand -hex 32` prints and ENCRYPTION_KEY takes.
func GenerateKey() (string, error) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return "", err
	}
	return hex.EncodeToString(key), nil
}

// ReadKeyFile returns the passphrase kept at path; ok is false when there is
// no file. Group and world access is removed, as for the database.
func ReadKeyFile(path string) (passphrase string, ok bool, err error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read key file: %w", err)
	}

	passphrase = strings.TrimSpace(string(data))
	if passphrase == "" {
		// Not the same as a missing file: replacing it would strand whatever
		// it sealed.
		return "", false, fmt.Errorf("key file %s is empty", path)
	}

	if info, err := os.Stat(path); err == nil && info.Mode().Perm()&0o077 != 0 {
		if err := os.Chmod(path, info.Mode().Perm()&0o700); err != nil {
			slog.Warn("could not restrict key file permissions", "path", path, "error", err)
		}
	}
	return passphrase, true, nil
}

// CreateKeyFile writes a fresh passphrase to path, readable by its owner
// alone. It never replaces a file already there.
func CreateKeyFile(path string) (string, error) {
	passphrase, err := GenerateKey()
	if err != nil {
		return "", err
	}

	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", fmt.Errorf("create key file: %w", err)
	}

	// On disk before anything is sealed under it: a key lost to a crash would
	// take every credential with it.
	_, err = file.WriteString(passphrase + "\n")
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(path)
		return "", fmt.Errorf("write key file: %w", err)
	}

	// The directory entry too. Best effort: Windows cannot sync a directory.
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		dir.Sync()
		dir.Close()
	}
	return passphrase, nil
}
