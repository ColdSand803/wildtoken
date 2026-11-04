// Package secret seals credentials at rest: channel API keys and the token
// plaintext the console copies.
//
// The scheme is faketoken's, so a value it sealed opens here once the prefix
// is added: AES-256-GCM under sha256(passphrase), no associated data, stored
// as base64(nonce ‖ ciphertext).
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

// prefix marks a sealed value. It tells one apart from the plaintext stored
// before sealing existed, which startup seals in place.
const prefix = "enc:v1:"

// ErrWrongKey reports a sealed value this key did not seal, or one damaged
// since.
var ErrWrongKey = errors.New("sealed value does not open with this key")

// Cipher seals and opens values under one key.
type Cipher struct {
	aead cipher.AEAD
}

// New derives the key from a passphrase: an ENCRYPTION_KEY value or a key
// file's contents, used as given.
func New(passphrase string) (*Cipher, error) {
	if passphrase == "" {
		return nil, errors.New("empty passphrase")
	}

	key := sha256.Sum256([]byte(passphrase))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Cipher{aead: aead}, nil
}

// Seal encrypts a value under a fresh nonce: "sk-abc" becomes "enc:v1:…", a
// different string each time. An empty value stays empty; it holds nothing.
func (c *Cipher) Seal(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}

	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := c.aead.Seal(nonce, nonce, []byte(plain), nil)
	return prefix + base64.StdEncoding.EncodeToString(sealed), nil
}

// Open decrypts a value Seal produced.
func (c *Cipher) Open(stored string) (string, error) {
	if stored == "" {
		return "", nil
	}

	encoded, ok := strings.CutPrefix(stored, prefix)
	if !ok {
		return "", errors.New("value is not sealed")
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(raw) < c.aead.NonceSize() {
		return "", ErrWrongKey
	}

	nonce, body := raw[:c.aead.NonceSize()], raw[c.aead.NonceSize():]
	plain, err := c.aead.Open(nil, nonce, body, nil)
	if err != nil {
		return "", ErrWrongKey
	}
	return string(plain), nil
}

// IsSealed reports whether a stored value came from Seal.
func IsSealed(stored string) bool {
	return strings.HasPrefix(stored, prefix)
}
