package app

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/config"
)

func touch(t *testing.T, path string, age time.Duration) {
	t.Helper()
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(-age)
	os.Chtimes(path, when, when)
}

// A new backup lands under its stamped name and the oldest go, past keep; the
// directory's other files, a stray .db among them, are left alone.
func TestABackupIsKeptAndTheOldestPruned(t *testing.T) {
	database, _, _ := legacyDatabase(t)
	dir := t.TempDir()
	for _, name := range []string{
		"wildtoken-20260101-050000.db", "wildtoken-20260102-050000.db",
		"wildtoken-20260103-050000.db", "wildtoken-manual.db", "notes.txt",
	} {
		touch(t, filepath.Join(dir, name), 0)
	}
	touch(t, filepath.Join(dir, "wildtoken-20260101-050000.db.part"), 2*time.Hour)
	touch(t, filepath.Join(dir, "wildtoken-20260104-050000.db.part"), 0)

	path, err := takeBackup(context.Background(), database,
		config.BackupSettings{Dir: dir, At: "05:00", Keep: 2})
	if err != nil {
		t.Fatal(err)
	}

	var left []string
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		left = append(left, entry.Name())
	}
	want := []string{"notes.txt", "wildtoken-20260103-050000.db", filepath.Base(path),
		"wildtoken-20260104-050000.db.part", "wildtoken-manual.db"}
	slices.Sort(want)
	if !slices.Equal(left, want) {
		t.Errorf("left %v\nwant %v", left, want)
	}

	backup, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer backup.Close()
	var channels int
	if err := backup.QueryRow("SELECT COUNT(*) FROM upstreams").Scan(&channels); err != nil || channels != 1 {
		t.Errorf("backup holds %d channels, %v; want 1", channels, err)
	}
}

func TestTheNextBackupIsTheNextTimeItsClockComesRound(t *testing.T) {
	zone := time.FixedZone("test", 8*3600)
	at := func(day, hour, minute int) time.Time { return time.Date(2026, 11, day, hour, minute, 0, 0, zone) }
	for _, c := range []struct{ now, want time.Time }{
		{at(4, 4, 59), at(4, 5, 0)},
		{at(4, 5, 0), at(5, 5, 0)},
		{at(4, 23, 0), at(5, 5, 0)},
	} {
		if got := nextBackupAt(c.now, 5, 0); !got.Equal(c.want) {
			t.Errorf("after %v: %v, want %v", c.now, got, c.want)
		}
	}
}

func TestTheNewestBackupIsReadFromItsName(t *testing.T) {
	dir := t.TempDir()
	if _, ok := newestBackup(dir); ok {
		t.Fatal("an empty directory reported a backup")
	}
	for _, name := range []string{"wildtoken-20261103-050000.db", "wildtoken-20261104-050000.db"} {
		touch(t, filepath.Join(dir, name), 0)
	}
	newest, ok := newestBackup(dir)
	if want := time.Date(2026, 11, 4, 5, 0, 0, 0, time.Local); !ok || !newest.Equal(want) {
		t.Errorf("newest = %v, %v; want %v", newest, ok, want)
	}
}

func TestTheBackupTimeMustBeAClock(t *testing.T) {
	if hour, minute, err := parseClock(" 5:30 "); err != nil || hour != 5 || minute != 30 {
		t.Errorf("5:30 read as %d:%d, %v", hour, minute, err)
	}
	for _, value := range []string{"", "25:00", "5", "noon"} {
		if _, _, err := parseClock(value); err == nil {
			t.Errorf("%q was accepted", value)
		}
	}
}
