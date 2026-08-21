package configpack

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
)

func samplePayload() *models.ConfigArchivePayload {
	key := "sk-secret-value"
	return &models.ConfigArchivePayload{
		Groups: []models.ConfigArchiveGroup{{Name: "default", Description: "默认分组"}},
		Channels: []models.ConfigArchiveChannel{{
			Name: "openai", BaseURL: "https://api.openai.com/v1", APIKey: &key,
			ModelNames: []string{"gpt-4o"}, ModelPrefixes: []string{},
			ModelMappings: map[string]string{}, Priority: 100, Weight: 100,
			Enabled: true, ExtraHeaders: map[string]string{}, TimeoutSeconds: 300,
			GroupNames: []string{"default"},
		}},
		Tokens: []models.ConfigArchiveToken{},
	}
}

// header returns the export header the handler would build.
func header() models.ConfigArchive {
	return models.ConfigArchive{
		AppVersion: "0.2.1", ExportedAt: "2026-08-20T00:00:00Z",
		Scopes: []string{models.ConfigScopeGroups, models.ConfigScopeChannels},
		// The sample carries a key, so the header says so — that flag is part of what
		// the AEAD authenticates.
		IncludesSecrets: true,
	}
}

// TestAnEncryptedArchiveRoundTrips is the base case.
func TestAnEncryptedArchiveRoundTrips(t *testing.T) {
	payload := samplePayload()
	sealed, err := Seal(header(), payload, "correct horse battery")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	if sealed.Payload != nil {
		t.Error("an encrypted archive must not also carry the plain payload")
	}
	if sealed.Encryption == nil {
		t.Fatal("no encryption block")
	}
	if sealed.Kind != models.ConfigArchiveKind {
		t.Errorf("kind = %q", sealed.Kind)
	}
	if sealed.SchemaVersion != models.ConfigArchiveSchemaVersion {
		t.Errorf("schema_version = %d", sealed.SchemaVersion)
	}

	opened, err := Open(&sealed, "correct horse battery")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if len(opened.Channels) != 1 || opened.Channels[0].Name != "openai" {
		t.Fatalf("payload did not survive the round trip: %+v", opened)
	}
	if opened.Channels[0].APIKey == nil || *opened.Channels[0].APIKey != "sk-secret-value" {
		t.Error("the channel key did not survive the round trip")
	}
}

// TestTheSecretIsNotReadableWithoutThePassword is what the whole encryption is
// for: the archive is a file that leaves the machine.
func TestTheSecretIsNotReadableWithoutThePassword(t *testing.T) {
	sealed, err := Seal(header(), samplePayload(), "a-strong-password")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	// The whole document as it would be written to disk.
	encoded, err := json.Marshal(sealed)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(encoded), "sk-secret-value") {
		t.Errorf("the key is in the archive in the clear:\n%s", encoded)
	}
	// Nor is the base URL, which is configuration rather than a credential but is
	// still inside the sealed body.
	if strings.Contains(string(encoded), "api.openai.com") {
		t.Errorf("archive contents are readable without the password:\n%s", encoded)
	}
}

// TestAWrongPasswordFailsBeforeAnythingIsRead: the caller must not receive a
// payload it can act on.
func TestAWrongPasswordFailsBeforeAnythingIsRead(t *testing.T) {
	sealed, err := Seal(header(), samplePayload(), "the-real-password")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	opened, err := Open(&sealed, "not-the-password")
	if !errors.Is(err, ErrWrongPassword) {
		t.Errorf("err = %v, want ErrWrongPassword", err)
	}
	if opened != nil {
		t.Error("a failed open returned a payload")
	}

	// An empty password is refused with a message naming the actual problem, rather
	// than reported as a wrong one.
	if _, err := Open(&sealed, ""); err == nil || errors.Is(err, ErrWrongPassword) {
		t.Errorf("err = %v, want a message saying a password is required", err)
	}
}

// TestATamperedArchiveDoesNotOpen covers the reason for using an AEAD at all: an
// archive travels through places this service does not control, and an
// unauthenticated cipher would let it be altered into different configuration.
func TestATamperedArchiveDoesNotOpen(t *testing.T) {
	sealed, err := Seal(header(), samplePayload(), "a-strong-password")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	t.Run("ciphertext flipped", func(t *testing.T) {
		altered := sealed
		encryption := *sealed.Encryption
		raw, err := base64.StdEncoding.DecodeString(encryption.Ciphertext)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		raw[len(raw)/2] ^= 0x01
		encryption.Ciphertext = base64.StdEncoding.EncodeToString(raw)
		altered.Encryption = &encryption

		if _, err := Open(&altered, "a-strong-password"); !errors.Is(err, ErrWrongPassword) {
			t.Errorf("err = %v, want the altered body refused", err)
		}
	})

	// The header is authenticated too. Without that, `includes_secrets` or the scope
	// list could be edited in transit while the body still opened, so the console
	// would describe the import as something other than what it applies.
	t.Run("header field edited", func(t *testing.T) {
		altered := sealed
		altered.IncludesSecrets = false

		if _, err := Open(&altered, "a-strong-password"); !errors.Is(err, ErrWrongPassword) {
			t.Errorf("err = %v, want an edited header refused", err)
		}
	})

	t.Run("scope list edited", func(t *testing.T) {
		altered := sealed
		altered.Scopes = []string{models.ConfigScopeSettings}

		if _, err := Open(&altered, "a-strong-password"); !errors.Is(err, ErrWrongPassword) {
			t.Errorf("err = %v, want an edited scope list refused", err)
		}
	})
}

// TestAnUnencryptedArchiveStillCarriesAVerifiedChecksum.
//
// An unencrypted archive has no AEAD tag, so the checksum is the only thing
// standing between a corrupted file and an import. A checksum that were only
// present in the encrypted case would be one an operator could not rely on.
func TestAnUnencryptedArchiveStillCarriesAVerifiedChecksum(t *testing.T) {
	payload := samplePayload()
	payload.Channels[0].APIKey = nil

	head := header()
	head.IncludesSecrets = false
	sealed, err := Seal(head, payload, "")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if sealed.Encryption != nil {
		t.Error("an unencrypted archive must not carry an encryption block")
	}
	if sealed.Checksum == "" {
		t.Fatal("no checksum on an unencrypted archive")
	}
	if _, err := Open(&sealed, ""); err != nil {
		t.Fatalf("open: %v", err)
	}

	// Contents edited without updating the checksum: the case a plain-text archive
	// is exposed to, whether by corruption or by hand.
	altered := sealed
	edited := *payload
	edited.Channels = []models.ConfigArchiveChannel{{
		Name: "attacker", BaseURL: "https://elsewhere.example/v1",
		GroupNames: []string{"default"},
	}}
	altered.Payload = &edited

	if _, err := Open(&altered, ""); err == nil {
		t.Error("an edited unencrypted archive was accepted")
	} else if !strings.Contains(err.Error(), "checksum") {
		t.Errorf("err = %v, want the checksum named", err)
	}
}

// TestTheChecksumIsStableForTheSamePayload: it is re-derived on import, so an
// unstable encoding would fail valid archives at random.
func TestTheChecksumIsStableForTheSamePayload(t *testing.T) {
	first, err := Checksum(samplePayload())
	if err != nil {
		t.Fatalf("checksum: %v", err)
	}
	for range 20 {
		again, err := Checksum(samplePayload())
		if err != nil {
			t.Fatalf("checksum: %v", err)
		}
		if again != first {
			t.Fatalf("checksum is not stable: %s != %s", again, first)
		}
	}

	// And it moves when the payload does, or it would not detect anything.
	changed := samplePayload()
	changed.Channels[0].Weight = 50
	other, err := Checksum(changed)
	if err != nil {
		t.Fatalf("checksum: %v", err)
	}
	if other == first {
		t.Error("the checksum did not change with the payload")
	}
}

// TestEachArchiveGetsItsOwnSaltAndNonce.
//
// A reused nonce breaks GCM outright, and a fixed salt would let one precomputed
// table attack every archive this instance ever produced.
func TestEachArchiveGetsItsOwnSaltAndNonce(t *testing.T) {
	salts := map[string]bool{}
	nonces := map[string]bool{}
	ciphertexts := map[string]bool{}

	for range 8 {
		sealed, err := Seal(header(), samplePayload(), "same-password-every-time")
		if err != nil {
			t.Fatalf("seal: %v", err)
		}
		salts[sealed.Encryption.Salt] = true
		nonces[sealed.Encryption.Nonce] = true
		ciphertexts[sealed.Encryption.Ciphertext] = true
	}

	if len(salts) != 8 {
		t.Errorf("%d distinct salts across 8 archives, want 8", len(salts))
	}
	if len(nonces) != 8 {
		t.Errorf("%d distinct nonces across 8 archives, want 8", len(nonces))
	}
	// The observable consequence: the same configuration sealed with the same
	// password twice must not produce the same bytes, or an observer learns that two
	// archives are identical.
	if len(ciphertexts) != 8 {
		t.Errorf("%d distinct ciphertexts, want 8", len(ciphertexts))
	}
}

// TestAHostileArchiveCannotAskForUnboundedWork.
//
// The KDF parameters travel with the archive so it stays readable after the
// defaults are raised, which means an uploaded file names them. Without a ceiling,
// `memory_kib: 4294967295` takes the process down before any password is checked.
func TestAHostileArchiveCannotAskForUnboundedWork(t *testing.T) {
	sealed, err := Seal(header(), samplePayload(), "a-strong-password")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	for name, mutate := range map[string]func(*models.ConfigArchiveEncryption){
		"absurd memory": func(e *models.ConfigArchiveEncryption) { e.MemoryKiB = 4294967295 },
		"absurd time":   func(e *models.ConfigArchiveEncryption) { e.TimeCost = 4294967295 },
		"zero time":     func(e *models.ConfigArchiveEncryption) { e.TimeCost = 0 },
		"absurd key":    func(e *models.ConfigArchiveEncryption) { e.KeyLength = 4294967295 },
		"bad key size":  func(e *models.ConfigArchiveEncryption) { e.KeyLength = 17 },
		"zero threads":  func(e *models.ConfigArchiveEncryption) { e.Parallelism = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			altered := sealed
			encryption := *sealed.Encryption
			mutate(&encryption)
			altered.Encryption = &encryption

			// Refused on the parameters rather than attempted: an error is the point,
			// and it must arrive without the allocation being made.
			if _, err := Open(&altered, "a-strong-password"); err == nil {
				t.Error("an out-of-range cost parameter was accepted")
			}
		})
	}
}

// TestAnArchiveFromANewerSchemaIsRefused: a newer schema may have changed what an
// existing field means, so reading it as understood would write values that look
// right and are not.
func TestAnArchiveFromANewerSchemaIsRefused(t *testing.T) {
	sealed, err := Seal(header(), samplePayload(), "")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	newer := sealed
	newer.SchemaVersion = models.ConfigArchiveSchemaVersion + 1
	if _, err := Open(&newer, ""); err == nil {
		t.Fatal("an archive from a newer schema was accepted")
	} else if !strings.Contains(err.Error(), "newer schema") {
		t.Errorf("err = %v, want the schema named", err)
	}

	// An older one is fine, which is the whole reason for versioning rather than
	// hashing the shape.
	older := sealed
	older.SchemaVersion = 1
	if _, err := Open(&older, ""); err != nil {
		t.Errorf("a schema 1 archive was refused: %v", err)
	}
}

// TestTheWrongKindOfDocumentIsRefusedBeforeAPasswordIsEvenChecked.
//
// A caller pointing the channel-only export at this endpoint should be told it is
// the wrong file, not given a password error to puzzle over.
func TestTheWrongKindOfDocumentIsRefusedBeforeAPasswordIsEvenChecked(t *testing.T) {
	for name, archive := range map[string]models.ConfigArchive{
		"channel export": {Kind: "wildtoken.channels", SchemaVersion: 1, Checksum: "x"},
		"no kind":        {SchemaVersion: 1, Checksum: "x"},
		"no checksum": {Kind: models.ConfigArchiveKind, SchemaVersion: 1,
			Payload: samplePayload()},
		"no body": {Kind: models.ConfigArchiveKind, SchemaVersion: 1, Checksum: "x"},
		"both bodies": {Kind: models.ConfigArchiveKind, SchemaVersion: 1, Checksum: "x",
			Payload:    samplePayload(),
			Encryption: &models.ConfigArchiveEncryption{Algorithm: AlgorithmAESGCM}},
		"unknown scope": {Kind: models.ConfigArchiveKind, SchemaVersion: 1, Checksum: "x",
			Payload: samplePayload(), Scopes: []string{"everything"}},
	} {
		t.Run(name, func(t *testing.T) {
			candidate := archive
			if _, err := Open(&candidate, "any-password"); err == nil {
				t.Error("a malformed archive was accepted")
			}
		})
	}
}

// TestAnArchiveCarryingRetiredPricesSaysSo.
//
// A version-1 archive can name the "pricing" scope, which this build no longer
// applies. Refused with an explanation rather than imported with the section
// skipped: silently dropping it is the case where an operator believes a
// migration was complete and finds a price table missing later.
func TestAnArchiveCarryingRetiredPricesSaysSo(t *testing.T) {
	head := header()
	head.IncludesSecrets = false
	payload := samplePayload()
	payload.Channels[0].APIKey = nil
	sealed, err := Seal(head, payload, "")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	// Exactly as a version-1 export from a build that still had the feature.
	older := sealed
	older.SchemaVersion = models.ConfigArchiveSchemaVersionWithPricing
	older.Scopes = []string{models.ConfigScopeChannels, models.ConfigScopePricing}

	_, err = Open(&older, "")
	if err == nil {
		t.Fatal("an archive naming the retired pricing scope was accepted")
	}
	if !strings.Contains(err.Error(), "prices") {
		t.Errorf("err = %v, want the retired feature named rather than a generic "+
			"unknown-scope refusal", err)
	}
	// And "pricing" is not something an export can produce any more.
	for _, scope := range models.ConfigScopes {
		if scope == models.ConfigScopePricing {
			t.Error("the retired pricing scope is still in the exportable list")
		}
	}
}

// TestAnUnsupportedAlgorithmIsNamed rather than being reported as a bad password.
func TestAnUnsupportedAlgorithmIsNamed(t *testing.T) {
	sealed, err := Seal(header(), samplePayload(), "a-strong-password")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	for field, mutate := range map[string]func(*models.ConfigArchiveEncryption){
		"algorithm": func(e *models.ConfigArchiveEncryption) { e.Algorithm = "rot13" },
		"kdf":       func(e *models.ConfigArchiveEncryption) { e.KDF = "md5" },
	} {
		t.Run(field, func(t *testing.T) {
			altered := sealed
			encryption := *sealed.Encryption
			mutate(&encryption)
			altered.Encryption = &encryption

			_, err := Open(&altered, "a-strong-password")
			if err == nil {
				t.Fatal("an unsupported algorithm was accepted")
			}
			if errors.Is(err, ErrWrongPassword) {
				t.Errorf("err = %v, want the unsupported %s named rather than a password error",
					err, field)
			}
		})
	}
}
