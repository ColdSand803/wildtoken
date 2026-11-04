package app

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/config"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/secret"
)

// setUpSecrets picks the key credentials are sealed under and brings the
// database in line with it.
//
// The key comes from ENCRYPTION_KEY, else from the key file beside the
// database, else from a key file made on the spot — the last only while
// nothing is sealed, since a new key cannot open what an old one sealed.
func setUpSecrets(ctx context.Context, database *sql.DB, settings config.DatabaseSettings) error {
	keyPath, err := secretKeyPath(settings)
	if err != nil {
		return err
	}

	filePassphrase, fileFound := "", false
	if keyPath != "" {
		if filePassphrase, fileFound, err = secret.ReadKeyFile(keyPath); err != nil {
			return err
		}
	}

	// Trimmed as faketoken trims it, so one configured value derives one key.
	passphrase := strings.TrimSpace(settings.EncryptionKey)

	var key, previous *secret.Cipher
	var source string
	switch {
	case passphrase != "":
		source = "ENCRYPTION_KEY"
		if len(passphrase) < 32 {
			slog.Warn("ENCRYPTION_KEY is short; generate one with: openssl rand -hex 32")
		}
		if key, err = secret.New(passphrase); err != nil {
			return err
		}
		// What the key file sealed before ENCRYPTION_KEY was set moves over.
		if fileFound {
			if previous, err = secret.New(filePassphrase); err != nil {
				return err
			}
		}
	case fileFound:
		source = keyPath
		if key, err = secret.New(filePassphrase); err != nil {
			return err
		}
	default:
		if source, key, err = newSecretKey(ctx, database, keyPath); err != nil {
			return err
		}
	}

	report, err := db.SealSecrets(ctx, database, key, previous)
	if err != nil {
		return fmt.Errorf("seal stored credentials: %w (key from %s)", err, source)
	}
	db.UseSecrets(key)

	slog.Info("credentials sealed at rest", "key", source,
		"sealed", report.Sealed, "resealed", report.Resealed)
	if report.Resealed > 0 {
		slog.Info("credentials moved off the key file; it now only opens older backups", "path", keyPath)
	}
	return nil
}

// newSecretKey makes the key for a database that has none yet.
func newSecretKey(ctx context.Context, database *sql.DB, keyPath string) (string, *secret.Cipher, error) {
	sealed, err := db.HasSealedSecrets(ctx, database)
	if err != nil {
		return "", nil, fmt.Errorf("read stored credentials: %w", err)
	}
	if sealed {
		return "", nil, fmt.Errorf("stored credentials are sealed, "+
			"but neither ENCRYPTION_KEY nor the key file %s is there to open them", keyPath)
	}

	source := keyPath + " (new)"
	var passphrase string
	if keyPath == "" {
		// An in-memory database dies with the process, and its key with it.
		source = "an in-memory key"
		passphrase, err = secret.GenerateKey()
	} else {
		passphrase, err = secret.CreateKeyFile(keyPath)
	}
	if err != nil {
		return "", nil, err
	}

	key, err := secret.New(passphrase)
	return source, key, err
}

// databaseFile is the database's path on disk, or "" for an in-memory one.
func databaseFile(settings config.DatabaseSettings) (string, error) {
	dsn, err := sqliteDSN(settings)
	if err != nil {
		return "", err
	}

	path, _, _ := strings.Cut(dsn, "?")
	path = strings.TrimPrefix(strings.TrimPrefix(path, "file:"), "//")
	if path == "" || strings.HasPrefix(path, ":memory:") {
		return "", nil
	}
	return path, nil
}

// secretKeyPath names the key file beside the database: "/data/wildtoken.db"
// keeps it in "/data/wildtoken.key". An in-memory database has none.
func secretKeyPath(settings config.DatabaseSettings) (string, error) {
	path, err := databaseFile(settings)
	if err != nil || path == "" {
		return "", err
	}

	keyPath := strings.TrimSuffix(path, filepath.Ext(path)) + ".key"
	if keyPath == path {
		// A database named x.key keeps its key in x.key.key, not in itself.
		keyPath += ".key"
	}
	return keyPath, nil
}
