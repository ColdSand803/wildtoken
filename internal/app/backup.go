package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/liguangsheng/wildtoken/internal/config"
	"github.com/liguangsheng/wildtoken/internal/db"
)

// backupName matches what takeBackup writes: wildtoken-20261104-050000.db.
var backupName = regexp.MustCompile(`^wildtoken-(\d{8}-\d{6})\.db$`)

const backupStamp = "20060102-150405"

// runBackupLoop takes a backup every day at settings.At, local time, keeping
// the newest settings.Keep. A start with none from the last day takes one a
// minute in: a restart must not cost a day, nor a restart loop a backup each.
func runBackupLoop(ctx context.Context, database *sql.DB, settings config.BackupSettings) {
	if settings.Dir == "" {
		slog.Warn("database backups are off: backup.dir is blank")
		return
	}
	hour, minute, err := parseClock(settings.At)
	if err == nil && settings.Keep < 1 {
		err = fmt.Errorf("backup.keep %d is below 1", settings.Keep)
	}
	if err != nil {
		slog.Error("database backups are off", "error", err)
		return
	}

	if newest, ok := newestBackup(settings.Dir); !ok || time.Since(newest) > 24*time.Hour {
		if !sleep(ctx, time.Minute) {
			return
		}
		backupAndLog(ctx, database, settings)
	}
	for sleep(ctx, time.Until(nextBackupAt(time.Now(), hour, minute))) {
		backupAndLog(ctx, database, settings)
	}
}

// BackupNow takes one backup and returns its path: what `wildtoken backup`
// runs before a migration or anything else worth a fresh restore point. It
// opens the database beside a running server, which SQLite allows.
func BackupNow(ctx context.Context) (string, error) {
	settings, err := config.Load()
	if err != nil {
		return "", fmt.Errorf("load configuration: %w", err)
	}
	if settings.Backup.Dir == "" {
		return "", errors.New("backup.dir is blank")
	}

	// Opening a path that is not there would make an empty database of it.
	path, err := databaseFile(settings.Database)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(path); path == "" || err != nil {
		return "", fmt.Errorf("no database file at %q", path)
	}

	database, err := openDatabase(ctx, settings.Database)
	if err != nil {
		return "", err
	}
	defer database.Close()
	return takeBackup(ctx, database, settings.Backup)
}

func backupAndLog(ctx context.Context, database *sql.DB, settings config.BackupSettings) {
	started := time.Now()
	path, err := takeBackup(ctx, database, settings)
	if err != nil {
		slog.Error("database backup failed", "error", err)
		return
	}
	var size int64
	if info, err := os.Stat(path); err == nil {
		size = info.Size()
	}
	slog.Info("database backed up", "path", path, "bytes", size,
		"took", time.Since(started).Round(time.Millisecond))
}

// takeBackup writes one backup and prunes past settings.Keep.
//
// It writes a .part file and renames it only once the copy checks out, so one
// cut short by a restart or a full disk is never taken for a usable one. It
// prunes only after a success: a run of failures must not erode the history
// standing in for them.
func takeBackup(ctx context.Context, database *sql.DB, settings config.BackupSettings) (string, error) {
	if err := os.MkdirAll(settings.Dir, 0o700); err != nil {
		return "", err
	}
	removeStaleParts(settings.Dir)

	final := filepath.Join(settings.Dir, "wildtoken-"+time.Now().Format(backupStamp)+".db")
	part := final + ".part"
	if err := db.Backup(ctx, database, part); err != nil {
		os.Remove(part)
		return "", err
	}
	if err := os.Rename(part, final); err != nil {
		os.Remove(part)
		return "", err
	}

	giveToDirOwner(final, settings.Dir)
	pruneBackups(settings.Dir, settings.Keep)
	return final, nil
}

// removeStaleParts drops .part files a crash left behind. An hour old at
// least: a younger one may be a backup another process is writing right now.
func removeStaleParts(dir string) {
	parts, _ := filepath.Glob(filepath.Join(dir, "wildtoken-*.db.part"))
	for _, part := range parts {
		if info, err := os.Stat(part); err == nil && time.Since(info.ModTime()) > time.Hour {
			os.Remove(part)
		}
	}
}

// pruneBackups keeps the newest keep backups. The stamp is fixed width, so
// name order is time order; mtime would not do, since a copy rewrites it.
func pruneBackups(dir string, keep int) {
	names := backupNames(dir)
	for _, name := range names[:max(len(names)-keep, 0)] {
		if err := os.Remove(filepath.Join(dir, name)); err != nil {
			slog.Warn("could not prune a backup", "name", name, "error", err)
			continue
		}
		slog.Info("pruned a backup", "name", name)
	}
}

// backupNames lists the backups in dir, oldest first.
func backupNames(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, entry := range entries {
		if entry.Type().IsRegular() && backupName.MatchString(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	return names
}

func newestBackup(dir string) (time.Time, bool) {
	names := backupNames(dir)
	if len(names) == 0 {
		return time.Time{}, false
	}
	stamp := backupName.FindStringSubmatch(names[len(names)-1])[1]
	taken, err := time.ParseInLocation(backupStamp, stamp, time.Local)
	return taken, err == nil
}

// nextBackupAt is the first hour:minute after now, in now's zone.
func nextBackupAt(now time.Time, hour, minute int) time.Time {
	next := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, now.Location())
	if !next.After(now) {
		next = next.AddDate(0, 0, 1)
	}
	return next
}

func parseClock(value string) (int, int, error) {
	parsed, err := time.Parse("15:04", strings.TrimSpace(value))
	if err != nil {
		return 0, 0, fmt.Errorf("backup.at %q is not HH:MM", value)
	}
	return parsed.Hour(), parsed.Minute(), nil
}

// sleep waits d, reporting false if ctx ends first.
func sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
