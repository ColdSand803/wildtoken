//go:build windows

package main

import _ "embed"

// trayIconPNG is a 32x32 tile carrying a light "W", matching the icon the Rust
// build drew at runtime.
//
//go:embed assets/tray-icon.png
var trayIconPNG []byte
