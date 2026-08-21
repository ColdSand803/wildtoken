package backup

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Restoring is a two-step operation: the running process stages a verified snapshot,
// and the next start adopts it.
//
// It is not done in place because the process holds the database open. On Windows an
// open file cannot be replaced at all, and even where it can, the connections in the
// pool keep reading the old inode — so the service would appear to have restored
// nothing until it happened to reconnect, and the WAL and shared-memory files
// alongside the old database would then be applied to the new one. Staging makes the
// swap happen at the one moment nothing is holding the file: before the pool opens.

// Paths names the files the restore uses, all beside the live database.
//
// Beside it rather than in a temp directory: the staged file has to be renamed onto
// the database, and a rename across filesystems is a copy that can fail halfway.
type Paths struct {
	Database string
	Staged   string
	Marker   string
	Rollback string
}

// PathsFor derives the restore paths for a database file.
func PathsFor(databasePath string) Paths {
	return Paths{
		Database: databasePath,
		Staged:   databasePath + ".restore-staged",
		Marker:   databasePath + ".restore-pending.json",
		Rollback: databasePath + ".rollback",
	}
}

// Marker records a staged restore for the next start to find.
//
// Written after the snapshot is verified, so its presence means "there is a checked
// database waiting", never "a restore was attempted".
type Marker struct {
	StagedAt  string `json:"staged_at"`
	Checksum  string `json:"checksum"`
	SizeBytes int64  `json:"size_bytes"`
	// SourceAppVersion is the version that produced the snapshot, kept so the log
	// line written at adoption says where the database came from.
	SourceAppVersion string `json:"source_app_version"`
	RollbackPath     string `json:"rollback_path"`
}

// WriteMarker records the staged restore.
//
// Written last, and only after the staged file has been verified: the marker is what
// makes the next start adopt the file, so it must not exist before the file is known
// good. Flushed to disk for the same reason — a marker lost to a crash means a
// verified restore silently does not happen.
func WriteMarker(paths Paths, marker Marker) error {
	encoded, err := json.MarshalIndent(marker, "", "  ")
	if err != nil {
		return fmt.Errorf("record staged restore: %w", err)
	}
	file, err := os.OpenFile(paths.Marker, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("record staged restore: %w", err)
	}
	defer file.Close()
	if _, err := file.Write(encoded); err != nil {
		return fmt.Errorf("record staged restore: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("record staged restore: %w", err)
	}
	return nil
}

// ReadMarker returns the staged restore, if there is one.
func ReadMarker(paths Paths) (Marker, bool, error) {
	encoded, err := os.ReadFile(paths.Marker)
	if errors.Is(err, os.ErrNotExist) {
		return Marker{}, false, nil
	}
	if err != nil {
		return Marker{}, false, fmt.Errorf("read staged restore: %w", err)
	}
	var marker Marker
	if err := json.Unmarshal(encoded, &marker); err != nil {
		// A marker that cannot be read is not treated as "no restore pending": that
		// would silently discard one an operator is waiting for. It is an error the
		// start refuses on, so a person decides.
		return Marker{}, false, fmt.Errorf("the staged restore record is unreadable: %w", err)
	}
	return marker, true, nil
}

// ClearStaged removes a staged restore and its marker.
//
// The marker goes first: while it exists the staged file is what the next start will
// adopt, and removing the file first would leave a marker pointing at nothing.
func ClearStaged(paths Paths) error {
	if err := os.Remove(paths.Marker); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("clear staged restore: %w", err)
	}
	if err := os.Remove(paths.Staged); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("clear staged restore: %w", err)
	}
	return nil
}

// AdoptPending applies a staged restore. Called at start, before the pool opens.
//
// Reports whether it adopted anything, so a normal start is silent and a restored one
// is logged. Any failure leaves the current database untouched: nothing is removed
// before the replacement is in place.
func AdoptPending(paths Paths) (adopted bool, marker Marker, err error) {
	marker, pending, err := ReadMarker(paths)
	if err != nil || !pending {
		return false, marker, err
	}

	staged, err := os.Stat(paths.Staged)
	if errors.Is(err, os.ErrNotExist) {
		// A marker without its file. Refused rather than ignored: the operator was
		// told a restore was staged, and starting on the old database as though
		// nothing happened is the one outcome they cannot detect.
		return false, marker, fmt.Errorf(
			"a restore was staged but %s is missing; remove %s to start on the current database",
			filepath.Base(paths.Staged), filepath.Base(paths.Marker))
	}
	if err != nil {
		return false, marker, fmt.Errorf("read staged restore: %w", err)
	}

	// Re-verified at adoption, not only when staged: the file has been sitting on
	// disk across a restart, and this is the last moment the current database still
	// exists.
	checksum, size, err := FileChecksum(paths.Staged)
	if err != nil {
		return false, marker, fmt.Errorf("verify staged restore: %w", err)
	}
	if marker.Checksum != "" && checksum != marker.Checksum {
		return false, marker, errors.New(
			"the staged restore no longer matches its recorded checksum; it was modified after staging and will not be adopted")
	}
	if size != staged.Size() {
		return false, marker, errors.New("the staged restore changed while being read")
	}

	// The current database is kept, not deleted: an operator who restored the wrong
	// file has one move left, and it is this.
	if err := os.Rename(paths.Database, paths.Rollback); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, marker, fmt.Errorf("set aside the current database: %w", err)
	}
	if err := os.Rename(paths.Staged, paths.Database); err != nil {
		// Put back, so a failed adoption starts on the database it had.
		if renameErr := os.Rename(paths.Rollback, paths.Database); renameErr != nil {
			return false, marker, fmt.Errorf(
				"adopt staged restore: %w (and the previous database is left at %s)",
				err, paths.Rollback)
		}
		return false, marker, fmt.Errorf("adopt staged restore: %w", err)
	}

	// The old WAL and shared-memory files describe the database that was just moved
	// aside. Left in place, SQLite would apply them to the restored file, which is
	// how a verified restore becomes a corrupt database.
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if err := os.Remove(paths.Database + suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			return false, marker, fmt.Errorf("remove stale %s file: %w", suffix, err)
		}
	}

	if err := os.Remove(paths.Marker); err != nil && !errors.Is(err, os.ErrNotExist) {
		// The swap already happened, so this cannot be undone — but a marker left
		// behind would make the next start look for a staged file that is now the
		// live database. Reported so it is fixed rather than discovered later.
		return true, marker, fmt.Errorf(
			"the restore was adopted but %s could not be removed: %w", paths.Marker, err)
	}
	return true, marker, nil
}

// CopyRollback copies the live database aside before a restore is staged.
//
// A snapshot rather than a file copy, for the same reason the backup itself is one: a
// byte copy of an open database can land mid-write. This one is what an operator
// falls back to, so it has to be restorable.
func RollbackName(databasePath string) string {
	return fmt.Sprintf("%s.pre-restore-%s", databasePath,
		time.Now().UTC().Format("20060102-150405"))
}
