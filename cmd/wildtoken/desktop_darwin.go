//go:build darwin && desktop

package main

import (
	_ "embed"
	"os"

	"github.com/liguangsheng/wildtoken/internal/desktop"
)

//go:embed assets/tray-icon.png
var desktopIcon []byte

func desktopMain() (bool, int) {
	return true, desktop.Run(os.Args[1:], desktopIcon)
}
