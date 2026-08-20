package backup

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"golang.org/x/crypto/argon2"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// The container's cryptography.
//
// The same primitives as the configuration archive, and for the same reason: the
// file leaves the instance, so an unauthenticated cipher would let it be altered in
// flight into a different database that still restores.
const (
	AlgorithmAESGCM = "aes-256-gcm"
	KDFArgon2id     = "argon2id"

	argon2Time        uint32 = 3
	argon2MemoryKiB   uint32 = 64 * 1024
	argon2Parallelism uint8  = 4
	argon2KeyLength   uint32 = 32

	saltLength = 16
)

// Read-side ceilings on the parameters the file declares. They travel with it so a
// backup stays readable after the defaults rise, which also means a hostile file can
// name them: without a bound, `memory_kib: 4294967295` asks for four terabytes
// before any password is checked.
const (
	maxArgon2MemoryKiB uint32 = 1024 * 1024
	maxArgon2Time      uint32 = 16
	maxArgon2KeyLength uint32 = 64

	// maxEncryptedBodyBytes is lower than the plaintext ceiling because AES-GCM here
	// is a one-shot Seal/Open over a buffer: an encrypted backup has to fit in
	// memory twice. A larger database can still be backed up unencrypted, which
	// streams.
	maxEncryptedBodyBytes int64 = 512 << 20 // 512 MiB
)

// ErrWrongPassword covers a wrong password and a tampered body alike: AES-GCM
// cannot distinguish them, so reporting them separately would mean guessing.
var ErrWrongPassword = errors.New(
	"could not open the backup: wrong password, or the file has been altered")

// ErrNotABackup is returned when the leading bytes are not this format.
var ErrNotABackup = errors.New("not a WildToken database backup")

// The on-disk layout:
//
//	magic  8 bytes
//	hdrLen 4 bytes, big endian
//	header hdrLen bytes of JSON
//	body   the snapshot, encrypted or not
//
// A length-prefixed header rather than a JSON document with the database
// base64-encoded inside it: base64 adds a third to a file that is already the
// largest thing this service produces, and both writing and reading it would have to
// hold the whole database in memory as a string.

// WriteContainer writes header and body into one file at destination.
//
// The plaintext path streams, so an unencrypted backup of a database larger than
// memory still works.
func WriteContainer(destination string, header models.BackupHeader,
	snapshotPath, password string) error {
	snapshot, err := os.Open(snapshotPath)
	if err != nil {
		return fmt.Errorf("read snapshot: %w", err)
	}
	defer snapshot.Close()

	var body io.Reader = snapshot
	if password != "" {
		info, err := snapshot.Stat()
		if err != nil {
			return fmt.Errorf("read snapshot: %w", err)
		}
		if info.Size() > maxEncryptedBodyBytes {
			return fmt.Errorf(
				"an encrypted backup is limited to %d MiB and this database is %d MiB; "+
					"take it without a password, or store it somewhere already protected",
				maxEncryptedBodyBytes>>20, info.Size()>>20)
		}
		plaintext, err := io.ReadAll(snapshot)
		if err != nil {
			return fmt.Errorf("read snapshot: %w", err)
		}
		sealed, encryption, err := sealBody(&header, plaintext, password)
		if err != nil {
			return err
		}
		header.Encryption = encryption
		body = bytes.NewReader(sealed)
	}

	encodedHeader, err := json.Marshal(header)
	if err != nil {
		return fmt.Errorf("encode backup header: %w", err)
	}
	if len(encodedHeader) > models.MaxBackupHeaderBytes {
		return errors.New("backup header is unexpectedly large")
	}

	file, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("write backup: %w", err)
	}
	defer file.Close()

	if _, err := file.Write([]byte(models.BackupMagic)); err != nil {
		return fmt.Errorf("write backup: %w", err)
	}
	length := make([]byte, 4)
	binary.BigEndian.PutUint32(length, uint32(len(encodedHeader)))
	if _, err := file.Write(length); err != nil {
		return fmt.Errorf("write backup: %w", err)
	}
	if _, err := file.Write(encodedHeader); err != nil {
		return fmt.Errorf("write backup: %w", err)
	}
	if _, err := io.Copy(file, body); err != nil {
		return fmt.Errorf("write backup: %w", err)
	}
	// Flushed before the caller is told this succeeded: a backup reported as written
	// and then lost to a crash is worse than one that failed loudly.
	if err := file.Sync(); err != nil {
		return fmt.Errorf("flush backup: %w", err)
	}
	return nil
}

// ReadHeader reads and validates a container's header without touching the body.
//
// Separate from opening the body so the restore path can refuse an incompatible or
// foreign file before asking for a password, and so the console can describe an
// uploaded file it has no password for.
func ReadHeader(reader io.Reader) (models.BackupHeader, error) {
	var header models.BackupHeader

	magic := make([]byte, len(models.BackupMagic))
	if _, err := io.ReadFull(reader, magic); err != nil {
		return header, ErrNotABackup
	}
	if string(magic) != models.BackupMagic {
		return header, ErrNotABackup
	}

	rawLength := make([]byte, 4)
	if _, err := io.ReadFull(reader, rawLength); err != nil {
		return header, ErrNotABackup
	}
	length := binary.BigEndian.Uint32(rawLength)
	// Bounded before the allocation, not after: the length is the file's own claim.
	if length == 0 || int64(length) > int64(models.MaxBackupHeaderBytes) {
		return header, errors.New("backup header length is implausible")
	}

	encoded := make([]byte, length)
	if _, err := io.ReadFull(reader, encoded); err != nil {
		return header, errors.New("backup header is truncated")
	}
	if err := json.Unmarshal(encoded, &header); err != nil {
		return header, fmt.Errorf("backup header is unreadable: %w", err)
	}
	if err := header.ValidateEnvelope(); err != nil {
		return header, err
	}
	return header, nil
}

// OpenBody writes the verified snapshot from reader into destination.
//
// The checksum is verified here, on every path, so nothing downstream can be handed
// a body that was not checked. For an encrypted body the GCM tag is checked first
// and the checksum after decryption: the tag proves the ciphertext is intact, the
// checksum proves the plaintext is the snapshot the header describes.
func OpenBody(reader io.Reader, header models.BackupHeader, destination, password string) error {
	if header.Encrypted() {
		return openEncryptedBody(reader, header, destination, password)
	}
	if password != "" {
		// Said plainly rather than ignored: an operator typing a password for an
		// unencrypted file has probably chosen the wrong file.
		return errors.New("this backup is not encrypted; leave the password empty")
	}
	return writeVerified(reader, header, destination)
}

// writeVerified streams the body to destination and checks the checksum as it goes.
func writeVerified(reader io.Reader, header models.BackupHeader, destination string) error {
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("stage snapshot: %w", err)
	}
	// Removed on any failure below, so a rejected body never sits on disk where a
	// later step could mistake it for a verified one.
	success := false
	defer func() {
		file.Close()
		if !success {
			os.Remove(destination)
		}
	}()

	// Bounded by the declared size, so a body that keeps coming cannot fill the disk.
	written, err := io.Copy(file, io.LimitReader(reader, header.SizeBytes))
	if err != nil {
		return fmt.Errorf("stage snapshot: %w", err)
	}
	if written != header.SizeBytes {
		return fmt.Errorf("the backup is truncated: %d of %d bytes",
			written, header.SizeBytes)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("stage snapshot: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("stage snapshot: %w", err)
	}

	checksum, _, err := FileChecksum(destination)
	if err != nil {
		return fmt.Errorf("verify snapshot: %w", err)
	}
	if checksum != header.Checksum {
		return errors.New("the backup's checksum does not match its contents; " +
			"the file is damaged or was altered")
	}
	success = true
	return nil
}

func openEncryptedBody(reader io.Reader, header models.BackupHeader,
	destination, password string) error {
	encryption := header.Encryption
	if encryption.Algorithm != AlgorithmAESGCM {
		return fmt.Errorf("unsupported backup encryption algorithm: %s", encryption.Algorithm)
	}
	if encryption.KDF != KDFArgon2id {
		return fmt.Errorf("unsupported backup key derivation: %s", encryption.KDF)
	}
	if password == "" {
		return errors.New("this backup is encrypted; a password is required")
	}
	if header.SizeBytes > maxEncryptedBodyBytes {
		return fmt.Errorf("an encrypted backup larger than %d MiB cannot be opened by this build",
			maxEncryptedBodyBytes>>20)
	}

	salt, err := base64.StdEncoding.DecodeString(encryption.Salt)
	if err != nil || len(salt) == 0 {
		return errors.New("backup salt is unreadable")
	}
	nonce, err := base64.StdEncoding.DecodeString(encryption.Nonce)
	if err != nil || len(nonce) == 0 {
		return errors.New("backup nonce is unreadable")
	}
	key, err := deriveKey(password, salt, encryption)
	if err != nil {
		return err
	}
	aead, err := newAEAD(key)
	if err != nil {
		return err
	}
	if len(nonce) != aead.NonceSize() {
		return errors.New("backup nonce is the wrong size")
	}

	// The ciphertext is bounded by the tag overhead plus the declared plaintext size,
	// which the envelope check has already bounded.
	ciphertext, err := io.ReadAll(io.LimitReader(reader,
		header.SizeBytes+int64(aead.Overhead())+1))
	if err != nil {
		return fmt.Errorf("read backup: %w", err)
	}

	plaintext, err := aead.Open(nil, nonce, ciphertext, additionalData(header))
	if err != nil {
		return ErrWrongPassword
	}
	// Checked after decryption as well as by the tag: the tag says the ciphertext is
	// what was sealed, the checksum says the plaintext is the snapshot the header
	// describes. Both, so no path adopts an unchecked body.
	if BytesChecksum(plaintext) != header.Checksum {
		return errors.New("the backup decrypted but its checksum does not match; " +
			"the file is damaged")
	}
	if int64(len(plaintext)) != header.SizeBytes {
		return errors.New("the backup's declared size does not match its contents")
	}

	if err := os.WriteFile(destination, plaintext, 0o600); err != nil {
		return fmt.Errorf("stage snapshot: %w", err)
	}
	return nil
}

// sealBody encrypts the snapshot and returns the metadata needed to open it again.
func sealBody(header *models.BackupHeader, plaintext []byte,
	password string) ([]byte, *models.BackupEncryption, error) {
	salt := make([]byte, saltLength)
	if _, err := rand.Read(salt); err != nil {
		return nil, nil, fmt.Errorf("generate salt: %w", err)
	}
	encryption := &models.BackupEncryption{
		Algorithm:     AlgorithmAESGCM,
		KDF:           KDFArgon2id,
		Salt:          base64.StdEncoding.EncodeToString(salt),
		TimeCost:      argon2Time,
		MemoryKiB:     argon2MemoryKiB,
		Parallelism:   argon2Parallelism,
		KeyLengthBits: argon2KeyLength * 8,
	}
	key, err := deriveKey(password, salt, encryption)
	if err != nil {
		return nil, nil, err
	}
	aead, err := newAEAD(key)
	if err != nil {
		return nil, nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, fmt.Errorf("generate nonce: %w", err)
	}
	encryption.Nonce = base64.StdEncoding.EncodeToString(nonce)

	// The header is bound as additional data, with Encryption set to what will be
	// written: otherwise an attacker could edit the fingerprint or the checksum and
	// the body would still open.
	bound := *header
	bound.Encryption = encryption
	sealed := aead.Seal(nil, nonce, plaintext, additionalData(bound))
	return sealed, encryption, nil
}

// additionalData is the header fields bound to the ciphertext.
//
// Written by hand rather than marshalling the struct, so adding a field to the
// header cannot silently change what past backups authenticate against and make them
// unopenable.
func additionalData(header models.BackupHeader) []byte {
	fields := []string{
		header.Kind,
		fmt.Sprint(header.SchemaVersion),
		header.AppVersion,
		header.CreatedAt,
		header.SchemaFingerprint,
		header.Checksum,
		fmt.Sprint(header.SizeBytes),
	}
	if header.Encryption != nil {
		fields = append(fields,
			header.Encryption.Algorithm, header.Encryption.KDF, header.Encryption.Salt)
	}
	joined := ""
	for _, field := range fields {
		joined += field + "\x1f"
	}
	return []byte(joined)
}

// deriveKey reproduces the key from the parameters the file itself declares.
//
// Every parameter is required rather than defaulted when absent. The writer always
// records all four, so a missing one is a header that was edited or truncated —
// and substituting this build's default for it would derive a different key, which
// surfaces as the operator's correct password being reported as wrong.
func deriveKey(password string, salt []byte, encryption *models.BackupEncryption) ([]byte, error) {
	time := encryption.TimeCost
	memory := encryption.MemoryKiB
	parallelism := encryption.Parallelism
	keyLength := encryption.KeyLengthBits / 8

	if time == 0 || time > maxArgon2Time {
		return nil, fmt.Errorf("backup time cost %d is out of range", time)
	}
	if memory == 0 || memory > maxArgon2MemoryKiB {
		return nil, fmt.Errorf("backup memory cost %d KiB is out of range", memory)
	}
	if parallelism == 0 {
		return nil, errors.New("backup parallelism is zero")
	}
	if keyLength == 0 || keyLength > maxArgon2KeyLength {
		return nil, fmt.Errorf("backup key length %d is out of range", keyLength)
	}
	if keyLength != 32 {
		// AES-256 is the only cipher this format has, so any other length is a file
		// claiming something this build cannot do — reported rather than truncated
		// into something that decrypts to nonsense.
		return nil, fmt.Errorf("backup key length %d is not supported", keyLength)
	}
	return argon2.IDKey([]byte(password), salt, time, memory, parallelism, keyLength), nil
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("initialise cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("initialise cipher: %w", err)
	}
	return aead, nil
}
