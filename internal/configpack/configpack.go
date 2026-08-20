// Package configpack seals and opens portable configuration archives.
//
// It holds the format's cryptography and its checksum, kept out of both the model
// package (which describes the shape) and the handlers (which do HTTP), because
// this is the part where a mistake is not visible in behaviour: an archive sealed
// with a reused nonce or an unauthenticated cipher still imports perfectly.
package configpack

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"golang.org/x/crypto/argon2"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// The sealed format's parameters.
//
// AES-256-GCM rather than a plain cipher: an archive travels through places this
// service does not control, and an unauthenticated one can be altered in flight
// so that it decrypts into different configuration. GCM's tag makes that a failure
// to open instead.
const (
	AlgorithmAESGCM = "aes-256-gcm"
	KDFArgon2id     = "argon2id"

	// Cost parameters, deliberately higher than the login path's. This password
	// guards a file, so it is attacked offline at whatever rate the attacker's
	// hardware allows, and there is no throttle in front of it. The cost is paid
	// once per export or import by an operator who is waiting on a file anyway.
	argon2Time        uint32 = 3
	argon2MemoryKiB   uint32 = 64 * 1024
	argon2Parallelism uint8  = 4
	argon2KeyLength   uint32 = 32

	saltLength = 16
)

// argon2 parameter ceilings for reading an archive.
//
// The parameters travel with the archive so it stays readable after the defaults
// are raised, which means a hostile archive can name them. Without a ceiling,
// `memory_kib: 4294967295` is a request to allocate four terabytes — the import
// would take the process down before any password was even checked.
const (
	maxArgon2MemoryKiB uint32 = 1024 * 1024 // 1 GiB
	maxArgon2Time      uint32 = 16
	maxArgon2KeyLength uint32 = 64
	maxCiphertextBytes        = 64 << 20 // 64 MiB
)

// ErrWrongPassword is returned when a body will not open.
//
// One error for a wrong password and for a tampered body, because AES-GCM cannot
// distinguish them: both are a tag that does not verify. Reporting them
// separately would mean guessing.
var ErrWrongPassword = errors.New(
	"could not open the archive: wrong password, or the archive has been altered")

// Checksum is the SHA-256 of the payload's canonical JSON, hex encoded.
//
// Canonical means encoding/json's own output for the payload struct: Go emits
// struct fields in declaration order and sorts map keys, so the same payload
// always produces the same bytes. That is what lets a checksum computed on export
// be re-derived on import.
func Checksum(payload *models.ConfigArchivePayload) (string, error) {
	encoded, err := canonicalJSON(payload)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func canonicalJSON(payload *models.ConfigArchivePayload) ([]byte, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode archive payload: %w", err)
	}
	return encoded, nil
}

// Seal builds the archive document, encrypting the payload when a password is
// given.
//
// The checksum is computed over the payload in both cases, so the verification an
// import performs does not depend on which form the archive took.
func Seal(header models.ConfigArchive, payload *models.ConfigArchivePayload,
	password string) (models.ConfigArchive, error) {
	checksum, err := Checksum(payload)
	if err != nil {
		return models.ConfigArchive{}, err
	}
	header.Kind = models.ConfigArchiveKind
	header.SchemaVersion = models.ConfigArchiveSchemaVersion
	header.Checksum = checksum

	if password == "" {
		header.Payload = payload
		header.Encryption = nil
		return header, nil
	}

	plaintext, err := canonicalJSON(payload)
	if err != nil {
		return models.ConfigArchive{}, err
	}

	salt := make([]byte, saltLength)
	if _, err := rand.Read(salt); err != nil {
		// Refused rather than falling back to a fixed salt. A predictable salt lets
		// one precomputed table attack every archive this instance ever produced.
		return models.ConfigArchive{}, fmt.Errorf("generate archive salt: %w", err)
	}

	block, err := aes.NewCipher(argon2.IDKey([]byte(password), salt,
		argon2Time, argon2MemoryKiB, argon2Parallelism, argon2KeyLength))
	if err != nil {
		return models.ConfigArchive{}, fmt.Errorf("build archive cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return models.ConfigArchive{}, fmt.Errorf("build archive aead: %w", err)
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return models.ConfigArchive{}, fmt.Errorf("generate archive nonce: %w", err)
	}

	header.Payload = nil
	header.Encryption = &models.ConfigArchiveEncryption{
		Algorithm:   AlgorithmAESGCM,
		KDF:         KDFArgon2id,
		Salt:        base64.StdEncoding.EncodeToString(salt),
		Nonce:       base64.StdEncoding.EncodeToString(nonce),
		TimeCost:    argon2Time,
		MemoryKiB:   argon2MemoryKiB,
		Parallelism: argon2Parallelism,
		KeyLength:   argon2KeyLength,
		Ciphertext: base64.StdEncoding.EncodeToString(
			aead.Seal(nil, nonce, plaintext, archiveAdditionalData(header))),
	}
	return header, nil
}

// Open returns the archive's payload, decrypting and verifying as needed.
//
// The checksum is verified here rather than by the caller, so there is no path
// that reads a payload without checking it.
func Open(archive *models.ConfigArchive, password string) (*models.ConfigArchivePayload, error) {
	if err := archive.ValidateEnvelope(); err != nil {
		return nil, err
	}

	payload := archive.Payload
	if archive.Encrypted() {
		if password == "" {
			return nil, models.ErrString("this archive is encrypted; a password is required")
		}
		decrypted, err := decrypt(archive, password)
		if err != nil {
			return nil, err
		}
		payload = decrypted
	}

	// Verified after decryption, over the payload rather than over the ciphertext:
	// what an import needs to know is that the configuration it is about to write
	// is the configuration that was exported.
	checksum, err := Checksum(payload)
	if err != nil {
		return nil, err
	}
	if checksum != archive.Checksum {
		return nil, models.ErrString(
			"archive checksum does not match its contents; the archive is corrupt or was altered")
	}
	return payload, nil
}

func decrypt(archive *models.ConfigArchive, password string) (*models.ConfigArchivePayload, error) {
	encryption := archive.Encryption
	if encryption.Algorithm != AlgorithmAESGCM {
		return nil, models.ErrString("unsupported archive encryption algorithm: " + encryption.Algorithm)
	}
	if encryption.KDF != KDFArgon2id {
		return nil, models.ErrString("unsupported archive key derivation: " + encryption.KDF)
	}
	if err := checkCostParameters(encryption); err != nil {
		return nil, err
	}

	salt, err := base64.StdEncoding.DecodeString(encryption.Salt)
	if err != nil || len(salt) == 0 {
		return nil, models.ErrString("archive salt is missing or malformed")
	}
	nonce, err := base64.StdEncoding.DecodeString(encryption.Nonce)
	if err != nil || len(nonce) == 0 {
		return nil, models.ErrString("archive nonce is missing or malformed")
	}
	ciphertext, err := base64.StdEncoding.DecodeString(encryption.Ciphertext)
	if err != nil || len(ciphertext) == 0 {
		return nil, models.ErrString("archive ciphertext is missing or malformed")
	}
	if len(ciphertext) > maxCiphertextBytes {
		return nil, models.ErrString("archive is too large to import")
	}

	block, err := aes.NewCipher(argon2.IDKey([]byte(password), salt,
		encryption.TimeCost, encryption.MemoryKiB, encryption.Parallelism,
		encryption.KeyLength))
	if err != nil {
		return nil, models.ErrString("archive key length is not supported")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, models.ErrString("archive encryption parameters are not supported")
	}
	if len(nonce) != aead.NonceSize() {
		return nil, models.ErrString("archive nonce length does not match its algorithm")
	}

	plaintext, err := aead.Open(nil, nonce, ciphertext, archiveAdditionalData(*archive))
	if err != nil {
		// Deliberately not wrapping the AEAD error: it says "message authentication
		// failed", which reads as corruption to an operator who simply mistyped.
		return nil, ErrWrongPassword
	}

	payload := &models.ConfigArchivePayload{}
	if err := json.Unmarshal(plaintext, payload); err != nil {
		return nil, models.ErrString("archive body is not a valid configuration payload")
	}
	return payload, nil
}

// checkCostParameters bounds what an archive may ask to be allocated.
//
// The parameters are read from the archive so it survives a change of defaults,
// which means a hostile file can name them. Bounded here rather than trusted,
// because argon2.IDKey allocates memory_kib before it does anything else.
func checkCostParameters(encryption *models.ConfigArchiveEncryption) error {
	switch {
	case encryption.TimeCost < 1 || encryption.TimeCost > maxArgon2Time:
		return models.ErrString("archive names an unsupported argon2 time cost")
	case encryption.MemoryKiB < 8 || encryption.MemoryKiB > maxArgon2MemoryKiB:
		return models.ErrString("archive names an unsupported argon2 memory cost")
	case encryption.Parallelism < 1:
		return models.ErrString("archive names an unsupported argon2 parallelism")
	case encryption.KeyLength != 16 && encryption.KeyLength != 24 && encryption.KeyLength != 32:
		// AES takes one of three key sizes. Anything else would fail in
		// aes.NewCipher with a message about key length that says nothing about the
		// archive.
		if encryption.KeyLength > maxArgon2KeyLength {
			return models.ErrString("archive names an unsupported argon2 key length")
		}
		return models.ErrString("archive key length must be 16, 24, or 32 bytes")
	}
	return nil
}

// archiveAdditionalData binds the ciphertext to the header it arrived with.
//
// Without it, the header is unauthenticated: an archive's `includes_secrets` or
// `scopes` could be edited in transit while the body still opened, so the console
// would describe the import as something other than what it applies. The fields
// chosen are the ones an import acts on.
func archiveAdditionalData(header models.ConfigArchive) []byte {
	// Built by hand rather than by marshalling the header, because the header also
	// carries the encryption block — which contains the ciphertext this is
	// authenticating.
	associated := struct {
		Kind            string   `json:"kind"`
		SchemaVersion   int      `json:"schema_version"`
		AppVersion      string   `json:"app_version"`
		ExportedAt      string   `json:"exported_at"`
		Scopes          []string `json:"scopes"`
		IncludesSecrets bool     `json:"includes_secrets"`
		Checksum        string   `json:"checksum"`
	}{
		Kind:            header.Kind,
		SchemaVersion:   header.SchemaVersion,
		AppVersion:      header.AppVersion,
		ExportedAt:      header.ExportedAt,
		Scopes:          header.Scopes,
		IncludesSecrets: header.IncludesSecrets,
		Checksum:        header.Checksum,
	}
	encoded, err := json.Marshal(associated)
	if err != nil {
		// Every field is a string, int, bool or []string, so this cannot fail. An
		// empty AAD would still be consistent between seal and open, so the archive
		// would work — it would just no longer bind the header.
		return nil
	}
	return encoded
}
