//go:build !windows

package main

// runTray reports whether a tray UI took over the process.
//
// Only Windows ships one, matching the Rust build: Linux and macOS run as a
// plain foreground server, which also keeps every target free of cgo.
func runTray() bool { return false }
