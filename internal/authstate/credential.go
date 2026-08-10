package authstate

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"

	"golang.org/x/crypto/argon2"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// Argon2id parameters, matching the defaults of the Rust `argon2` crate this
// service previously used. They must not change without a migration: a hash
// records its own parameters, so verification of stored credentials keeps
// working, but new hashes should stay comparable in cost to the old ones.
const (
	argonMemoryKiB uint32 = 19456
	argonTime      uint32 = 2
	argonThreads   uint8  = 1
	argonKeyLen    uint32 = 32
	argonSaltLen          = 16
	argonVersion          = argon2.Version // 0x13, the `v=19` in a PHC string
)

// phcEncoding is the unpadded standard base64 alphabet PHC strings use.
var phcEncoding = base64.StdEncoding.WithPadding(base64.NoPadding)

var errMalformedHash = errors.New("malformed Argon2 PHC string")

// HashAdminToken derives a PHC-encoded Argon2id hash. The plaintext is never
// persisted.
func HashAdminToken(token string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("could not hash admin credential: %w", err)
	}
	key := argon2.IDKey([]byte(token), salt, argonTime, argonMemoryKiB, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argonVersion, argonMemoryKiB, argonTime, argonThreads,
		phcEncoding.EncodeToString(salt), phcEncoding.EncodeToString(key)), nil
}

// VerifyAdminToken checks a token against a stored credential snapshot.
//
// The parameters come from the stored string rather than the constants above,
// so a hash written by an older build with different settings still verifies.
func VerifyAdminToken(credential models.AdminCredential, token string) bool {
	memory, time, threads, salt, expected, err := parsePHC(credential.CredentialHash)
	if err != nil {
		return false
	}
	derived := argon2.IDKey([]byte(token), salt, time, memory, threads, uint32(len(expected)))
	return subtle.ConstantTimeCompare(derived, expected) == 1
}

// parsePHC decodes `$argon2id$v=19$m=...,t=...,p=...$salt$hash`.
func parsePHC(encoded string) (memory, time uint32, threads uint8, salt, hash []byte, err error) {
	fields := strings.Split(encoded, "$")
	// A well-formed string starts with an empty field, because it begins with '$'.
	if len(fields) != 6 || fields[0] != "" || fields[1] != "argon2id" {
		return 0, 0, 0, nil, nil, errMalformedHash
	}

	var version int
	if _, err := fmt.Sscanf(fields[2], "v=%d", &version); err != nil {
		return 0, 0, 0, nil, nil, errMalformedHash
	}
	if version != argonVersion {
		return 0, 0, 0, nil, nil, fmt.Errorf("%w: unsupported version %d", errMalformedHash, version)
	}

	var parsedThreads uint8
	if _, err := fmt.Sscanf(fields[3], "m=%d,t=%d,p=%d", &memory, &time, &parsedThreads); err != nil {
		return 0, 0, 0, nil, nil, errMalformedHash
	}

	if salt, err = phcEncoding.DecodeString(fields[4]); err != nil {
		return 0, 0, 0, nil, nil, errMalformedHash
	}
	if hash, err = phcEncoding.DecodeString(fields[5]); err != nil {
		return 0, 0, 0, nil, nil, errMalformedHash
	}
	if len(salt) == 0 || len(hash) == 0 {
		return 0, 0, 0, nil, nil, errMalformedHash
	}
	return memory, time, parsedThreads, salt, hash, nil
}

// cachedToken records a fingerprint alongside the credential generation it was
// proven against, so a stale credential cannot be admitted from the cache.
type cachedToken struct {
	credentialVersion int64
	fingerprint       [32]byte
}

// authCache remembers tokens that already passed a real verification.
type authCache struct {
	key [32]byte
	// mu guards a comparison only. Holding it across the Argon2id verification
	// is what would let unauthenticated callers stall authenticated ones.
	mu       sync.Mutex
	verified *cachedToken
	queue    *verificationQueue

	// argon2Verifications counts real verifications, for tests asserting the
	// cache actually absorbs repeat traffic.
	argon2Verifications atomic.Uint64
}

func newAuthCache() (*authCache, error) {
	cache := &authCache{queue: newVerificationQueue()}
	if _, err := rand.Read(cache.key[:]); err != nil {
		return nil, fmt.Errorf("could not seed the admin authentication cache: %w", err)
	}
	return cache, nil
}

func (c *authCache) fingerprint(token string) [32]byte {
	mac := hmac.New(sha256.New, c.key[:])
	mac.Write([]byte(token))
	return [32]byte(mac.Sum(nil))
}

func (c *authCache) hit(fingerprint [32]byte, credentialVersion int64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.verified == nil || c.verified.credentialVersion != credentialVersion {
		return false
	}
	return subtle.ConstantTimeCompare(c.verified.fingerprint[:], fingerprint[:]) == 1
}

func (c *authCache) store(fingerprint [32]byte, credentialVersion int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.verified = &cachedToken{credentialVersion: credentialVersion, fingerprint: fingerprint}
}

func (c *authCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.verified = nil
}

// Credentials authenticates admin tokens against the current credential.
type Credentials struct {
	mu      sync.RWMutex
	current models.AdminCredential
	// version is the commit generation, advanced before publishing a newly
	// committed snapshot. This closes the commit-to-publication window for
	// newly-started requests.
	version  atomic.Int64
	cache    *authCache
	throttle *Throttle
}

// NewCredentials publishes an already-committed credential snapshot.
func NewCredentials(credential models.AdminCredential, throttle *Throttle) (*Credentials, error) {
	cache, err := newAuthCache()
	if err != nil {
		return nil, err
	}
	credentials := &Credentials{current: credential, cache: cache, throttle: throttle}
	credentials.version.Store(credential.CredentialVersion)
	return credentials, nil
}

// Snapshot returns the current credential.
func (c *Credentials) Snapshot() models.AdminCredential {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.current
}

// Version returns the current commit generation.
func (c *Credentials) Version() int64 { return c.version.Load() }

// Authenticate reports the credential generation a token proved itself against.
func (c *Credentials) Authenticate(token string, client Client) (int64, bool) {
	fingerprint := c.cache.fingerprint(token)

	// A token that has already been verified is answered without touching the
	// verification slot, so wrong-token traffic cannot queue ahead of a signed-in
	// operator. The cache is cleared on rotation, and every entry carries the
	// generation it was proven against, so a stale credential cannot be admitted
	// here.
	credentialVersion := c.version.Load()
	if c.cache.hit(fingerprint, credentialVersion) {
		return credentialVersion, true
	}

	if !c.throttle.Admit(client) {
		return 0, false
	}
	release, admitted := c.cache.queue.enter()
	if !admitted {
		return 0, false
	}
	defer release()

	// Whoever held the slot may have just verified this same token.
	credentialVersion = c.version.Load()
	if c.cache.hit(fingerprint, credentialVersion) {
		return credentialVersion, true
	}

	credential := c.Snapshot()
	if credential.CredentialVersion != credentialVersion {
		return 0, false
	}

	c.cache.argon2Verifications.Add(1)
	if !VerifyAdminToken(credential, token) {
		c.throttle.RecordFailure(client)
		return 0, false
	}
	// A rotation that landed mid-verification is not the caller's failure, so it
	// costs them nothing but this request.
	if c.version.Load() != credentialVersion {
		return 0, false
	}

	c.cache.store(fingerprint, credentialVersion)
	c.throttle.RecordSuccess(client)
	return credentialVersion, true
}

// Publish installs a credential that has already committed to SQLite.
//
// The atomic generation closes the commit-to-publication window for
// authentication. Advancing it monotonically makes that signal irreversible,
// while the lock keeps the credential snapshot itself monotonic when rotations
// complete their database work out of order.
func (c *Credentials) Publish(credential models.AdminCredential) {
	for {
		current := c.version.Load()
		if credential.CredentialVersion <= current {
			break
		}
		if c.version.CompareAndSwap(current, credential.CredentialVersion) {
			break
		}
	}

	c.mu.Lock()
	if credential.CredentialVersion > c.current.CredentialVersion {
		c.current = credential
	}
	c.mu.Unlock()

	c.cache.clear()
}
