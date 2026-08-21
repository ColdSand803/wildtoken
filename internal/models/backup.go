package models

import "strings"

// The disaster-recovery archive's envelope.
//
// Deliberately a different format from the configuration archive: that one is a
// JSON document describing configuration by name, portable between instances. This
// one is a byte-for-byte SQLite database, including request logs and the admin
// credential, and it is only meaningful to an instance of the same schema. Sharing
// one format would invite restoring a full database when the operator meant to
// migrate settings.
const (
	BackupMagic         = "WTBAK1\x00\x00"
	BackupKind          = "wildtoken.backup"
	BackupSchemaVersion = 1

	// maxBackupHeaderBytes bounds the declared header length before it is read, so
	// an uploaded file cannot ask the process to allocate an arbitrary amount before
	// anything about it has been checked.
	MaxBackupHeaderBytes = 64 << 10 // 64 KiB
	// MaxBackupBodyBytes bounds the snapshot itself. This one is generous because a
	// real database legitimately gets large, but it is not unbounded: the restore
	// path reads the body to verify it.
	MaxBackupBodyBytes = 4 << 30 // 4 GiB
)

// BackupHeader travels in front of the snapshot, unencrypted, so an operator can
// read what a file is before deciding to restore it — and so the restore path can
// refuse an incompatible one without a password.
//
// When the body is encrypted this header is also the AEAD's additional data, which
// is what stops an attacker editing SchemaFingerprint to make a foreign snapshot
// look compatible.
type BackupHeader struct {
	Kind          string `json:"kind"`
	SchemaVersion int    `json:"schema_version"`
	AppVersion    string `json:"app_version"`
	CreatedAt     string `json:"created_at"`

	// SchemaFingerprint is the SHA-256 of the source database's sorted DDL. This
	// service has no user_version bookkeeping, and a hand-maintained number drifts
	// from the schema it claims to describe; the DDL cannot.
	SchemaFingerprint string `json:"schema_fingerprint"`

	// Checksum is the SHA-256 of the plaintext snapshot, hex encoded. Verified after
	// decryption too, so no path adopts a body it has not checked.
	Checksum  string `json:"checksum"`
	SizeBytes int64  `json:"size_bytes"`

	// PageSize and PageCount describe the snapshot as SQLite reports it, so the
	// console can show what a file holds without opening it.
	PageSize  int64 `json:"page_size"`
	PageCount int64 `json:"page_count"`

	// Encryption is absent for a plaintext snapshot.
	Encryption *BackupEncryption `json:"encryption,omitempty"`
}

// BackupEncryption carries what is needed to derive the key again, which is why the
// cost parameters travel with the file rather than being read from this build's
// constants: raising the defaults must not make yesterday's backup unreadable.
type BackupEncryption struct {
	Algorithm     string `json:"algorithm"`
	KDF           string `json:"kdf"`
	Salt          string `json:"salt"`
	Nonce         string `json:"nonce"`
	TimeCost      uint32 `json:"time_cost"`
	MemoryKiB     uint32 `json:"memory_kib"`
	Parallelism   uint8  `json:"parallelism"`
	KeyLengthBits uint32 `json:"key_length_bits"`
}

func (h *BackupHeader) Encrypted() bool { return h.Encryption != nil }

// ValidateEnvelope checks what can be checked before a password is involved.
func (h *BackupHeader) ValidateEnvelope() error {
	if h.Kind != BackupKind {
		// Named rather than reported as a generic parse failure: the most likely
		// mistake is uploading a configuration archive here, and the two are easy to
		// confuse in a downloads folder.
		if h.Kind == ConfigArchiveKind {
			return ErrString("this is a configuration archive, not a database backup; " +
				"import it from the configuration migration card instead")
		}
		return ErrString("not a WildToken database backup")
	}
	if h.SchemaVersion <= 0 {
		return ErrString("backup schema_version is missing")
	}
	if h.SchemaVersion > BackupSchemaVersion {
		return ErrString("this backup was produced by a newer version of WildToken; " +
			"upgrade before restoring it")
	}
	if strings.TrimSpace(h.Checksum) == "" {
		return ErrString("backup checksum is missing")
	}
	if h.SizeBytes <= 0 {
		return ErrString("backup declares an empty snapshot")
	}
	if h.SizeBytes > MaxBackupBodyBytes {
		return ErrString("backup is larger than this build will read")
	}
	if h.Encryption != nil {
		if h.Encryption.Algorithm == "" || h.Encryption.KDF == "" {
			return ErrString("backup encryption metadata is incomplete")
		}
	}
	return nil
}

// BackupInfoOut is what the console shows about a file, or about the instance's own
// database before a backup is taken.
type BackupInfoOut struct {
	AppVersion        string `json:"app_version"`
	SchemaVersion     int    `json:"schema_version"`
	SchemaFingerprint string `json:"schema_fingerprint"`
	CreatedAt         string `json:"created_at"`
	SizeBytes         int64  `json:"size_bytes"`
	PageSize          int64  `json:"page_size"`
	PageCount         int64  `json:"page_count"`
	Encrypted         bool   `json:"encrypted"`

	// Compatible and Incompatibility are the console's answer to "can I restore
	// this here". Reported rather than left for the operator to compare fingerprints
	// by eye.
	Compatible      bool   `json:"compatible"`
	Incompatibility string `json:"incompatibility,omitempty"`
}

// RestoreRequest is the restore call's body.
//
// The archive travels as base64 rather than a multipart upload so the endpoint has
// one content type and the password is not a form field beside the file; the size
// cost is accepted for an operation an operator performs by hand.
type RestoreRequest struct {
	Archive  string `json:"archive"`
	Password string `json:"password"`
	// DryRun verifies the file — checksum, integrity check, schema — and reports
	// what would happen, without staging anything.
	DryRun bool `json:"dry_run"`
	// Confirm must be the literal string below for a real restore. A restore
	// replaces every row the instance has, including the admin credential, and a
	// bare boolean is too easy to send by accident from a half-written client.
	Confirm string `json:"confirm"`
	// AllowSchemaMismatch lets an operator override the fingerprint check. Offered
	// because a backup taken minutes before an upgrade is exactly what someone
	// needs during an incident, and refusing outright would leave them editing the
	// file by hand.
	AllowSchemaMismatch bool `json:"allow_schema_mismatch"`
}

// RestoreConfirmation is the phrase a real restore must carry.
const RestoreConfirmation = "restore"

func (r *RestoreRequest) Validate() error {
	if strings.TrimSpace(r.Archive) == "" {
		return ErrString("archive is required")
	}
	if !r.DryRun && r.Confirm != RestoreConfirmation {
		return ErrString(`a restore must be confirmed with confirm: "` +
			RestoreConfirmation + `"`)
	}
	return nil
}

// RestoreResponse reports what the restore did, or would do.
type RestoreResponse struct {
	DryRun bool `json:"dry_run"`
	// Verified means the file's checksum, integrity check and schema all passed.
	// Always reported, because it is the part a dry run exists to establish.
	Verified bool          `json:"verified"`
	Backup   BackupInfoOut `json:"backup"`
	Current  BackupInfoOut `json:"current"`

	// Staged means the snapshot is written and verified on disk and will be adopted
	// on the next start. False for a dry run.
	Staged bool `json:"staged"`
	// RequiresRestart is true whenever a snapshot was staged: the running process
	// holds the database open, and replacing a file underneath an open SQLite
	// connection is not something to do while serving.
	RequiresRestart bool `json:"requires_restart"`
	// RollbackPath is where the pre-restore database was copied. Reported so an
	// operator who restored the wrong file knows where the old one went.
	RollbackPath string `json:"rollback_path,omitempty"`
	// Warnings carries things that did not stop the restore, such as an overridden
	// schema mismatch.
	Warnings []string `json:"warnings"`
}

// PendingRestoreOut lets the console show a staged restore that has not been
// adopted yet, so a restart is not the only way to find out one is waiting.
type PendingRestoreOut struct {
	Pending   bool   `json:"pending"`
	StagedAt  string `json:"staged_at,omitempty"`
	SizeBytes int64  `json:"size_bytes,omitempty"`
	Checksum  string `json:"checksum,omitempty"`
}
