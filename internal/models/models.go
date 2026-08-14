// Package models holds the request, response, and row shapes shared by the
// database, proxy, and handler layers.
package models

// ErrString is a validation failure carrying only a fixed message, matching the
// `Result<(), &'static str>` contract the Rust validators used.
type ErrString string

func (e ErrString) Error() string { return string(e) }
