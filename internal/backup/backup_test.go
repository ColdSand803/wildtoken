package backup

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// liveDB opens a real on-disk database, because every property here is about files.
// An in-memory database has no path to snapshot and no WAL to leave behind.
func liveDB(t *testing.T, name string) (*sql.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), name+".db")
	database, err := sql.Open("sqlite",
		"file:"+filepath.ToSlash(path)+"?_pragma=journal_mode(wal)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { database.Close() })

	// The tables the restore path requires, plus one with data to compare.
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS upstreams (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)`,
		`CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)`,
		`CREATE TABLE IF NOT EXISTS upstream_groups (upstream_id INTEGER, group_id INTEGER)`,
		`CREATE TABLE IF NOT EXISTS api_tokens (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS request_logs (id INTEGER PRIMARY KEY, note TEXT)`,
		`CREATE TABLE IF NOT EXISTS runtime_settings (id INTEGER PRIMARY KEY, revision INTEGER)`,
	} {
		if _, err := database.Exec(statement); err != nil {
			t.Fatalf("schema: %v", err)
		}
	}
	return database, path
}

func seedRows(t *testing.T, database *sql.DB, count int) {
	t.Helper()
	for index := 0; index < count; index += 1 {
		if _, err := database.Exec("INSERT INTO request_logs (note) VALUES (?)",
			"row"); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
}

func rowCount(t *testing.T, database *sql.DB) int64 {
	t.Helper()
	var count int64
	if err := database.QueryRow("SELECT COUNT(*) FROM request_logs").Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	return count
}

// openSnapshotCount reads a snapshot file's row count without going through the
// service.
func openSnapshotCount(t *testing.T, path string) int64 {
	t.Helper()
	database, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro")
	if err != nil {
		t.Fatalf("open snapshot: %v", err)
	}
	defer database.Close()
	var count int64
	if err := database.QueryRow("SELECT COUNT(*) FROM request_logs").Scan(&count); err != nil {
		t.Fatalf("count in snapshot: %v", err)
	}
	return count
}

// TestASnapshotTakenUnderContinuousWritesIsConsistent is the checklist's
// continuous-write requirement.
//
// A byte copy taken while writes land catches pages mid-write and misses whatever is
// still in the WAL. The snapshot must be the database as of one instant: a whole
// number of committed transactions, and a file that passes its own integrity check.
func TestASnapshotTakenUnderContinuousWritesIsConsistent(t *testing.T) {
	database, _ := liveDB(t, "busy")
	seedRows(t, database, 50)

	stop := make(chan struct{})
	var writers sync.WaitGroup
	writers.Add(1)
	go func() {
		defer writers.Done()
		for {
			select {
			case <-stop:
				return
			default:
				// Ignoring the error: the point is sustained write pressure, and a busy
				// timeout expiring is not what this test is about.
				database.Exec("INSERT INTO request_logs (note) VALUES ('concurrent')")
			}
		}
	}()
	// Long enough that writes are certainly in flight when the snapshot starts.
	time.Sleep(50 * time.Millisecond)

	snapshotPath := filepath.Join(t.TempDir(), "snapshot.db")
	snapshotErr := Snapshot(context.Background(), database, snapshotPath)
	close(stop)
	writers.Wait()

	if snapshotErr != nil {
		t.Fatalf("snapshot under load: %v", snapshotErr)
	}
	if err := Verify(context.Background(), snapshotPath); err != nil {
		t.Fatalf("the snapshot is not a valid database: %v", err)
	}

	// A whole number of committed rows, and at least what was there before the
	// writers started. A torn snapshot shows up as an unreadable file or a count
	// below the pre-existing 50.
	count := openSnapshotCount(t, snapshotPath)
	if count < 50 {
		t.Errorf("the snapshot holds %d rows but 50 were committed before it began", count)
	}

	// And the checksum is stable: the file is not still being written when Snapshot
	// returns.
	first, _, err := FileChecksum(snapshotPath)
	if err != nil {
		t.Fatalf("checksum: %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	second, _, err := FileChecksum(snapshotPath)
	if err != nil {
		t.Fatalf("checksum: %v", err)
	}
	if first != second {
		t.Error("the snapshot changed after Snapshot returned")
	}
}

// TestASnapshotDoesNotDependOnTheWalFileBesideIt.
//
// VACUUM INTO applies the WAL as it reads, so the snapshot must be complete on its
// own. If it were not, restoring it without the source's WAL would silently lose the
// most recent commits.
func TestASnapshotDoesNotDependOnTheWalFileBesideIt(t *testing.T) {
	database, path := liveDB(t, "wal")
	seedRows(t, database, 30)

	// Written but not checkpointed: these rows live in the WAL.
	if _, err := database.Exec("INSERT INTO request_logs (note) VALUES ('in-wal')"); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := os.Stat(path + "-wal"); err != nil {
		t.Skipf("this build is not in WAL mode, so there is nothing to prove: %v", err)
	}

	snapshotPath := filepath.Join(t.TempDir(), "snapshot.db")
	if err := Snapshot(context.Background(), database, snapshotPath); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	// No -wal beside the snapshot: it is a single self-contained file.
	if _, err := os.Stat(snapshotPath + "-wal"); err == nil {
		t.Error("the snapshot left a WAL file, so it is not self-contained")
	}

	if count := openSnapshotCount(t, snapshotPath); count != 31 {
		t.Errorf("the snapshot holds %d rows, want all 31 including the uncheckpointed one",
			count)
	}
}

// TestAnEncryptedBackupRoundTripsAndIsUnreadableWithoutThePassword.
func TestAnEncryptedBackupRoundTripsAndIsUnreadableWithoutThePassword(t *testing.T) {
	database, _ := liveDB(t, "round")
	if _, err := database.Exec(
		"INSERT INTO api_tokens (name) VALUES ('a-recognisable-token-name')"); err != nil {
		t.Fatalf("seed: %v", err)
	}

	workspace := t.TempDir()
	snapshotPath := filepath.Join(workspace, "snapshot.db")
	if err := Snapshot(context.Background(), database, snapshotPath); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	header := headerFor(t, snapshotPath)

	containerPath := filepath.Join(workspace, "backup.wtbak")
	if err := WriteContainer(containerPath, header, snapshotPath, "a-long-password"); err != nil {
		t.Fatalf("write container: %v", err)
	}

	// The database's contents must not be readable in the file that leaves the host.
	encoded, err := os.ReadFile(containerPath)
	if err != nil {
		t.Fatalf("read container: %v", err)
	}
	if bytes.Contains(encoded, []byte("a-recognisable-token-name")) {
		t.Error("a token name is readable in an encrypted backup")
	}

	restored := filepath.Join(workspace, "restored.db")
	reader := bytes.NewReader(encoded)
	openedHeader, err := ReadHeader(reader)
	if err != nil {
		t.Fatalf("read header: %v", err)
	}
	if !openedHeader.Encrypted() {
		t.Fatal("the header does not report the body as encrypted")
	}
	if err := OpenBody(reader, openedHeader, restored, "a-long-password"); err != nil {
		t.Fatalf("open body: %v", err)
	}
	if err := Verify(context.Background(), restored); err != nil {
		t.Fatalf("the restored file is not a valid database: %v", err)
	}

	// Byte-identical to the snapshot: a restore must produce the database that was
	// backed up, not an equivalent one.
	original, err := os.ReadFile(snapshotPath)
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	roundTripped, err := os.ReadFile(restored)
	if err != nil {
		t.Fatalf("read restored: %v", err)
	}
	if !bytes.Equal(original, roundTripped) {
		t.Error("the restored database differs from the snapshot byte for byte")
	}
}

// headerFor builds the header the handler would build.
func headerFor(t *testing.T, snapshotPath string) models.BackupHeader {
	t.Helper()
	checksum, size, err := FileChecksum(snapshotPath)
	if err != nil {
		t.Fatalf("checksum: %v", err)
	}
	stats, fingerprint, err := Inspect(context.Background(), snapshotPath)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	return models.BackupHeader{
		Kind: models.BackupKind, SchemaVersion: models.BackupSchemaVersion,
		AppVersion: "test", CreatedAt: time.Now().UTC().Format(time.RFC3339),
		SchemaFingerprint: fingerprint, Checksum: checksum, SizeBytes: size,
		PageSize: stats.PageSize, PageCount: stats.PageCount,
	}
}

// container builds a backup file and returns its bytes.
func container(t *testing.T, password string) ([]byte, models.BackupHeader) {
	t.Helper()
	database, _ := liveDB(t, "container")
	seedRows(t, database, 5)

	workspace := t.TempDir()
	snapshotPath := filepath.Join(workspace, "snapshot.db")
	if err := Snapshot(context.Background(), database, snapshotPath); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	header := headerFor(t, snapshotPath)
	containerPath := filepath.Join(workspace, "backup.wtbak")
	if err := WriteContainer(containerPath, header, snapshotPath, password); err != nil {
		t.Fatalf("write container: %v", err)
	}
	encoded, err := os.ReadFile(containerPath)
	if err != nil {
		t.Fatalf("read container: %v", err)
	}
	return encoded, header
}

// TestTheWrongPasswordIsRefusedAndStagesNothing.
func TestTheWrongPasswordIsRefusedAndStagesNothing(t *testing.T) {
	encoded, _ := container(t, "the-real-password")
	destination := filepath.Join(t.TempDir(), "candidate.db")

	reader := bytes.NewReader(encoded)
	header, err := ReadHeader(reader)
	if err != nil {
		t.Fatalf("read header: %v", err)
	}
	err = OpenBody(reader, header, destination, "not-the-password")
	if !errors.Is(err, ErrWrongPassword) {
		t.Fatalf("error = %v, want ErrWrongPassword", err)
	}
	if _, statErr := os.Stat(destination); statErr == nil {
		t.Error("a refused body was written to disk anyway")
	}
}

// TestADamagedBackupIsRefusedBeforeItCanBeStaged is the checklist's integrity
// requirement: a file that arrives altered must fail, not restore.
func TestADamagedBackupIsRefusedBeforeItCanBeStaged(t *testing.T) {
	for name, damage := range map[string]func([]byte) []byte{
		"a flipped byte in the body": func(encoded []byte) []byte {
			altered := append([]byte(nil), encoded...)
			altered[len(altered)-20] ^= 0xff
			return altered
		},
		"a truncated file": func(encoded []byte) []byte {
			return encoded[:len(encoded)-64]
		},
		"a corrupted magic": func(encoded []byte) []byte {
			altered := append([]byte(nil), encoded...)
			altered[2] = 'X'
			return altered
		},
	} {
		t.Run(name, func(t *testing.T) {
			encoded, _ := container(t, "")
			altered := damage(encoded)
			destination := filepath.Join(t.TempDir(), "candidate.db")

			reader := bytes.NewReader(altered)
			header, err := ReadHeader(reader)
			if err != nil {
				// A damaged magic or header fails here, which is the earliest possible
				// point and therefore the right one.
				return
			}
			if err := OpenBody(reader, header, destination, ""); err == nil {
				t.Fatal("a damaged backup was accepted")
			}
			if _, statErr := os.Stat(destination); statErr == nil {
				t.Error("a rejected body was left on disk")
			}
		})
	}
}

// TestAnEditedHeaderIsRefusedOnAnEncryptedBackup.
//
// The header is bound as additional data, so editing the fingerprint to make a
// foreign snapshot look compatible must break decryption rather than pass.
func TestAnEditedHeaderIsRefusedOnAnEncryptedBackup(t *testing.T) {
	encoded, header := container(t, "a-long-password")

	// Rewriting the fingerprint inside the JSON header, keeping its length so the
	// length prefix stays valid — the tampering a length check alone would miss.
	original := []byte(header.SchemaFingerprint)
	forged := append([]byte("0"), original[1:]...)
	altered := bytes.Replace(encoded, original, forged, 1)
	if bytes.Equal(altered, encoded) {
		t.Fatal("the fixture did not alter the header")
	}

	reader := bytes.NewReader(altered)
	openedHeader, err := ReadHeader(reader)
	if err != nil {
		t.Fatalf("the edited header should still parse: %v", err)
	}
	destination := filepath.Join(t.TempDir(), "candidate.db")
	if err := OpenBody(reader, openedHeader, destination, "a-long-password"); err == nil {
		t.Error("an edited header was accepted, so the header is not authenticated")
	}
}

// TestAnEditedPlaintextBodyIsRefused: an unencrypted backup has no tag, so the
// checksum is the only thing standing between a damaged file and a restore.
func TestAnEditedPlaintextBodyIsRefused(t *testing.T) {
	encoded, header := container(t, "")
	reader := bytes.NewReader(encoded)
	if _, err := ReadHeader(reader); err != nil {
		t.Fatalf("read header: %v", err)
	}
	body := make([]byte, header.SizeBytes)
	if _, err := reader.Read(body); err != nil {
		t.Fatalf("read body: %v", err)
	}
	body[len(body)/2] ^= 0xff

	destination := filepath.Join(t.TempDir(), "candidate.db")
	err := OpenBody(bytes.NewReader(body), header, destination, "")
	if err == nil {
		t.Fatal("an edited plaintext body was accepted")
	}
	if !bytes.Contains([]byte(err.Error()), []byte("checksum")) &&
		!bytes.Contains([]byte(err.Error()), []byte("校验")) {
		t.Errorf("the refusal does not mention the checksum: %v", err)
	}
}

// TestAConfigurationArchiveIsNotMistakenForABackup.
//
// The two files sit in the same downloads folder and the mistake is easy; saying which
// one this is beats a parse error.
func TestAConfigurationArchiveIsNotMistakenForABackup(t *testing.T) {
	// Not this format at all: a configuration archive is bare JSON.
	_, err := ReadHeader(bytes.NewReader([]byte(`{"kind":"wildtoken.config","schema_version":1}`)))
	if !errors.Is(err, ErrNotABackup) {
		t.Errorf("error = %v, want ErrNotABackup", err)
	}

	// And a header that declares the configuration kind is named specifically.
	header := models.BackupHeader{
		Kind: models.ConfigArchiveKind, SchemaVersion: 1,
		Checksum: "abc", SizeBytes: 10,
	}
	err = header.ValidateEnvelope()
	if err == nil {
		t.Fatal("a configuration archive kind was accepted as a backup")
	}
	if !bytes.Contains([]byte(err.Error()), []byte("configuration archive")) {
		t.Errorf("the refusal does not say which format this is: %v", err)
	}
}

// TestABackupFromANewerBuildIsRefused: a schema this build does not know may differ in
// ways that only show up as wrong behaviour after the restore.
func TestABackupFromANewerBuildIsRefused(t *testing.T) {
	header := models.BackupHeader{
		Kind: models.BackupKind, SchemaVersion: models.BackupSchemaVersion + 1,
		Checksum: "abc", SizeBytes: 10,
	}
	if err := header.ValidateEnvelope(); err == nil {
		t.Fatal("a newer backup schema was accepted")
	}
}

// TestAHostileHeaderCannotAskForUnboundedWork: the cost parameters travel with the
// file so it stays readable after the defaults rise, which means a hostile file can
// name them.
func TestAHostileHeaderCannotAskForUnboundedWork(t *testing.T) {
	for name, encryption := range map[string]models.BackupEncryption{
		"absurd memory": {Algorithm: AlgorithmAESGCM, KDF: KDFArgon2id,
			MemoryKiB: 4_294_967_295, TimeCost: 1, Parallelism: 1, KeyLengthBits: 256},
		"absurd time": {Algorithm: AlgorithmAESGCM, KDF: KDFArgon2id,
			MemoryKiB: 1024, TimeCost: 1_000_000, Parallelism: 1, KeyLengthBits: 256},
		"zero parallelism": {Algorithm: AlgorithmAESGCM, KDF: KDFArgon2id,
			MemoryKiB: 1024, TimeCost: 1, Parallelism: 0, KeyLengthBits: 256},
		"unsupported key size": {Algorithm: AlgorithmAESGCM, KDF: KDFArgon2id,
			MemoryKiB: 1024, TimeCost: 1, Parallelism: 1, KeyLengthBits: 128},
	} {
		t.Run(name, func(t *testing.T) {
			candidate := encryption
			if _, err := deriveKey("password", []byte("saltsaltsaltsalt"), &candidate); err == nil {
				t.Error("a hostile cost parameter was accepted")
			}
		})
	}
}

// TestAnUnsupportedAlgorithmIsNamedRatherThanReportedAsAPasswordProblem.
func TestAnUnsupportedAlgorithmIsNamedRatherThanReportedAsAPasswordProblem(t *testing.T) {
	header := models.BackupHeader{
		Kind: models.BackupKind, SchemaVersion: 1, Checksum: "abc", SizeBytes: 10,
		Encryption: &models.BackupEncryption{Algorithm: "rot13", KDF: KDFArgon2id},
	}
	err := OpenBody(bytes.NewReader([]byte("body")), header,
		filepath.Join(t.TempDir(), "out.db"), "password")
	if err == nil {
		t.Fatal("an unsupported algorithm was accepted")
	}
	if errors.Is(err, ErrWrongPassword) {
		t.Error("an unsupported algorithm was reported as a wrong password")
	}
	if !bytes.Contains([]byte(err.Error()), []byte("rot13")) {
		t.Errorf("the algorithm is not named: %v", err)
	}
}

// TestTheSchemaFingerprintIgnoresCreationOrderAndFormatting.
//
// Two databases with the same tables must fingerprint alike however they were built,
// or every restore would be reported as a schema mismatch.
func TestTheSchemaFingerprintIgnoresCreationOrderAndFormatting(t *testing.T) {
	first, _ := liveDB(t, "order-a")
	firstPrint, err := SchemaFingerprint(context.Background(), first)
	if err != nil {
		t.Fatalf("fingerprint: %v", err)
	}

	// The same tables in a different order, one of them reformatted.
	second := filepath.Join(t.TempDir(), "order-b.db")
	other, err := sql.Open("sqlite", "file:"+filepath.ToSlash(second))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer other.Close()
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS runtime_settings (id INTEGER PRIMARY KEY, revision INTEGER)`,
		`CREATE TABLE IF NOT EXISTS request_logs (id INTEGER PRIMARY KEY,
		     note   TEXT)`,
		`CREATE TABLE IF NOT EXISTS api_tokens (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS upstream_groups (upstream_id INTEGER, group_id INTEGER)`,
		`CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)`,
		`CREATE TABLE IF NOT EXISTS upstreams (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)`,
	} {
		if _, err := other.Exec(statement); err != nil {
			t.Fatalf("schema: %v", err)
		}
	}
	secondPrint, err := SchemaFingerprint(context.Background(), other)
	if err != nil {
		t.Fatalf("fingerprint: %v", err)
	}

	if firstPrint != secondPrint {
		t.Error("the same schema fingerprinted differently depending on how it was built")
	}

	// And a real difference does change it, or the check would be worthless.
	if _, err := other.Exec("CREATE TABLE extra (id INTEGER PRIMARY KEY)"); err != nil {
		t.Fatalf("add table: %v", err)
	}
	changed, err := SchemaFingerprint(context.Background(), other)
	if err != nil {
		t.Fatalf("fingerprint: %v", err)
	}
	if changed == secondPrint {
		t.Error("adding a table did not change the fingerprint")
	}
}

// TestAFileThatIsNotThisServicesDatabaseIsRefused: restoring some other SQLite file
// would leave an instance that starts and then fails on every query.
func TestAFileThatIsNotThisServicesDatabaseIsRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "foreign.db")
	foreign, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := foreign.Exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)"); err != nil {
		t.Fatalf("schema: %v", err)
	}
	foreign.Close()

	err = LooksLikeWildToken(context.Background(), path)
	if err == nil {
		t.Fatal("a foreign SQLite database was accepted")
	}
	if !bytes.Contains([]byte(err.Error()), []byte("upstreams")) {
		t.Errorf("the refusal does not say what is missing: %v", err)
	}
}

// TestAFileThatIsNotADatabaseAtAllIsRefused.
func TestAFileThatIsNotADatabaseAtAllIsRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-a-database.db")
	if err := os.WriteFile(path, []byte("this is just text"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := Verify(context.Background(), path); err == nil {
		t.Error("a text file passed the integrity check")
	}
	if err := LooksLikeWildToken(context.Background(), path); err == nil {
		t.Error("a text file was accepted as a database")
	}
}

// TestABlankInstanceCanBeRestoredInto is the checklist's blank-instance case: the
// snapshot must carry everything, so it restores onto a fresh install with no
// configuration of its own.
func TestABlankInstanceCanBeRestoredInto(t *testing.T) {
	source, _ := liveDB(t, "populated")
	seedRows(t, source, 12)
	if _, err := source.Exec(
		"INSERT INTO upstreams (name) VALUES ('openai')"); err != nil {
		t.Fatalf("seed: %v", err)
	}

	workspace := t.TempDir()
	snapshotPath := filepath.Join(workspace, "snapshot.db")
	if err := Snapshot(context.Background(), source, snapshotPath); err != nil {
		t.Fatalf("snapshot: %v", err)
	}

	// The blank instance: an empty file at the path a fresh install would use.
	blankPath := filepath.Join(workspace, "blank.db")
	blank, err := sql.Open("sqlite", "file:"+filepath.ToSlash(blankPath))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := blank.Exec("CREATE TABLE placeholder (id INTEGER)"); err != nil {
		t.Fatalf("touch: %v", err)
	}
	blank.Close()

	paths := PathsFor(blankPath)
	if err := os.Rename(snapshotPath, paths.Staged); err != nil {
		t.Fatalf("stage: %v", err)
	}
	checksum, size, err := FileChecksum(paths.Staged)
	if err != nil {
		t.Fatalf("checksum: %v", err)
	}
	if err := WriteMarker(paths, Marker{
		StagedAt: time.Now().UTC().Format(time.RFC3339),
		Checksum: checksum, SizeBytes: size, SourceAppVersion: "test",
	}); err != nil {
		t.Fatalf("marker: %v", err)
	}

	adopted, _, err := AdoptPending(paths)
	if err != nil {
		t.Fatalf("adopt: %v", err)
	}
	if !adopted {
		t.Fatal("nothing was adopted")
	}

	restored, err := sql.Open("sqlite", "file:"+filepath.ToSlash(blankPath)+"?mode=ro")
	if err != nil {
		t.Fatalf("open restored: %v", err)
	}
	defer restored.Close()
	var count int64
	if err := restored.QueryRow("SELECT COUNT(*) FROM request_logs").Scan(&count); err != nil {
		t.Fatalf("the restored database does not have the source's tables: %v", err)
	}
	if count != 12 {
		t.Errorf("restored %d rows, want 12", count)
	}
	var name string
	if err := restored.QueryRow("SELECT name FROM upstreams").Scan(&name); err != nil ||
		name != "openai" {
		t.Errorf("channel = %q (%v), want openai", name, err)
	}
	// The marker is consumed, or the next start would look for a file that is now the
	// live database.
	if _, err := os.Stat(paths.Marker); err == nil {
		t.Error("the marker survived adoption")
	}
}

// TestAdoptionRemovesTheStaleWalBesideTheReplacedDatabase.
//
// The old -wal describes the database that was just moved aside. Left in place,
// SQLite applies it to the restored file, which is how a verified restore becomes a
// corrupt database.
func TestAdoptionRemovesTheStaleWalBesideTheReplacedDatabase(t *testing.T) {
	database, path := liveDB(t, "stale")
	seedRows(t, database, 5)
	if _, err := database.Exec(
		"INSERT INTO request_logs (note) VALUES ('uncheckpointed')"); err != nil {
		t.Fatalf("write: %v", err)
	}

	snapshotPath := filepath.Join(t.TempDir(), "snapshot.db")
	if err := Snapshot(context.Background(), database, snapshotPath); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	// Closed, as the process would be at the next start.
	database.Close()

	// A stale WAL beside the live database, which is what a running instance leaves.
	if err := os.WriteFile(path+"-wal", []byte("stale wal contents"), 0o600); err != nil {
		t.Fatalf("write stale wal: %v", err)
	}

	paths := PathsFor(path)
	if err := os.Rename(snapshotPath, paths.Staged); err != nil {
		t.Fatalf("stage: %v", err)
	}
	checksum, size, err := FileChecksum(paths.Staged)
	if err != nil {
		t.Fatalf("checksum: %v", err)
	}
	if err := WriteMarker(paths, Marker{Checksum: checksum, SizeBytes: size}); err != nil {
		t.Fatalf("marker: %v", err)
	}
	if adopted, _, err := AdoptPending(paths); err != nil || !adopted {
		t.Fatalf("adopt: %v (adopted=%v)", err, adopted)
	}

	if _, err := os.Stat(path + "-wal"); err == nil {
		t.Error("the stale WAL was left beside the restored database")
	}
	if err := Verify(context.Background(), path); err != nil {
		t.Errorf("the restored database does not verify: %v", err)
	}
}

// TestTheReplacedDatabaseIsKeptForRollback: an operator who restored the wrong file
// has exactly one move left, and it is this.
func TestTheReplacedDatabaseIsKeptForRollback(t *testing.T) {
	database, path := liveDB(t, "rollback")
	seedRows(t, database, 7)
	database.Close()

	other, _ := liveDB(t, "replacement")
	seedRows(t, other, 99)
	snapshotPath := filepath.Join(t.TempDir(), "snapshot.db")
	if err := Snapshot(context.Background(), other, snapshotPath); err != nil {
		t.Fatalf("snapshot: %v", err)
	}

	paths := PathsFor(path)
	if err := os.Rename(snapshotPath, paths.Staged); err != nil {
		t.Fatalf("stage: %v", err)
	}
	checksum, size, err := FileChecksum(paths.Staged)
	if err != nil {
		t.Fatalf("checksum: %v", err)
	}
	if err := WriteMarker(paths, Marker{Checksum: checksum, SizeBytes: size}); err != nil {
		t.Fatalf("marker: %v", err)
	}
	if adopted, _, err := AdoptPending(paths); err != nil || !adopted {
		t.Fatalf("adopt: %v", err)
	}

	previous, err := sql.Open("sqlite", "file:"+filepath.ToSlash(paths.Rollback)+"?mode=ro")
	if err != nil {
		t.Fatalf("open rollback: %v", err)
	}
	defer previous.Close()
	var count int64
	if err := previous.QueryRow("SELECT COUNT(*) FROM request_logs").Scan(&count); err != nil {
		t.Fatalf("the rollback copy is not readable: %v", err)
	}
	if count != 7 {
		t.Errorf("the rollback copy holds %d rows, want the pre-restore 7", count)
	}
}

// TestAStagedRestoreEditedAfterStagingIsNotAdopted.
//
// The file sits on disk across a restart, so the checksum is re-verified at the last
// moment the current database still exists.
func TestAStagedRestoreEditedAfterStagingIsNotAdopted(t *testing.T) {
	database, path := liveDB(t, "edited")
	seedRows(t, database, 3)
	database.Close()

	other, _ := liveDB(t, "candidate")
	seedRows(t, other, 20)
	snapshotPath := filepath.Join(t.TempDir(), "snapshot.db")
	if err := Snapshot(context.Background(), other, snapshotPath); err != nil {
		t.Fatalf("snapshot: %v", err)
	}

	paths := PathsFor(path)
	if err := os.Rename(snapshotPath, paths.Staged); err != nil {
		t.Fatalf("stage: %v", err)
	}
	checksum, size, err := FileChecksum(paths.Staged)
	if err != nil {
		t.Fatalf("checksum: %v", err)
	}
	if err := WriteMarker(paths, Marker{Checksum: checksum, SizeBytes: size}); err != nil {
		t.Fatalf("marker: %v", err)
	}

	// Altered after the marker was written.
	staged, err := os.OpenFile(paths.Staged, os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open staged: %v", err)
	}
	if _, err := staged.WriteAt([]byte{0xff}, 100); err != nil {
		t.Fatalf("alter: %v", err)
	}
	staged.Close()

	adopted, _, err := AdoptPending(paths)
	if adopted {
		t.Error("a staged file altered after staging was adopted")
	}
	if err == nil {
		t.Fatal("no error reported")
	}
	// And the current database is untouched, so the start can proceed on it once the
	// operator clears the staged file.
	if _, statErr := os.Stat(path); statErr != nil {
		t.Errorf("the current database was moved despite the failure: %v", statErr)
	}
}

// TestAMarkerWithoutItsFileIsRefusedRatherThanIgnored.
//
// Starting on the old database as though nothing was staged is the one outcome the
// operator cannot detect: they were told a restore was waiting.
func TestAMarkerWithoutItsFileIsRefusedRatherThanIgnored(t *testing.T) {
	database, path := liveDB(t, "orphan")
	seedRows(t, database, 4)
	database.Close()

	paths := PathsFor(path)
	if err := WriteMarker(paths, Marker{Checksum: "deadbeef", SizeBytes: 10}); err != nil {
		t.Fatalf("marker: %v", err)
	}

	adopted, _, err := AdoptPending(paths)
	if adopted {
		t.Error("a marker with no staged file adopted something")
	}
	if err == nil {
		t.Fatal("a marker with no staged file was ignored")
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Error("the current database was disturbed")
	}
}

// TestNoMarkerMeansAnOrdinaryStart, which is the overwhelmingly common case and must
// be silent and cheap.
func TestNoMarkerMeansAnOrdinaryStart(t *testing.T) {
	database, path := liveDB(t, "ordinary")
	seedRows(t, database, 2)

	adopted, _, err := AdoptPending(PathsFor(path))
	if err != nil {
		t.Fatalf("an ordinary start reported an error: %v", err)
	}
	if adopted {
		t.Error("an ordinary start adopted something")
	}
	if rowCount(t, database) != 2 {
		t.Error("an ordinary start changed the database")
	}
}

// TestCancellingAStagedRestoreLeavesTheDatabaseAlone.
func TestCancellingAStagedRestoreLeavesTheDatabaseAlone(t *testing.T) {
	database, path := liveDB(t, "cancel")
	seedRows(t, database, 6)

	other, _ := liveDB(t, "unwanted")
	seedRows(t, other, 500)
	snapshotPath := filepath.Join(t.TempDir(), "snapshot.db")
	if err := Snapshot(context.Background(), other, snapshotPath); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	paths := PathsFor(path)
	if err := os.Rename(snapshotPath, paths.Staged); err != nil {
		t.Fatalf("stage: %v", err)
	}
	if err := WriteMarker(paths, Marker{Checksum: "abc", SizeBytes: 1}); err != nil {
		t.Fatalf("marker: %v", err)
	}

	if err := ClearStaged(paths); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if _, err := os.Stat(paths.Marker); err == nil {
		t.Error("the marker survived cancellation")
	}
	if _, err := os.Stat(paths.Staged); err == nil {
		t.Error("the staged file survived cancellation")
	}

	// And the next start is an ordinary one.
	adopted, _, err := AdoptPending(paths)
	if err != nil || adopted {
		t.Errorf("a cancelled restore was still adopted: adopted=%v err=%v", adopted, err)
	}
	if rowCount(t, database) != 6 {
		t.Error("cancellation changed the live database")
	}
}

// TestAnUnreadableMarkerStopsTheStartRatherThanBeingDiscarded.
func TestAnUnreadableMarkerStopsTheStartRatherThanBeingDiscarded(t *testing.T) {
	_, path := liveDB(t, "garbled")
	paths := PathsFor(path)
	if err := os.WriteFile(paths.Marker, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	if _, _, err := ReadMarker(paths); err == nil {
		t.Error("an unreadable marker was treated as no restore pending")
	}
}
