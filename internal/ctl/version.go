package ctl

import (
	"runtime/debug"
	"strings"
)

func clientVersion() string {
	info, _ := debug.ReadBuildInfo()
	return buildVersion(Version, info)
}

// go install keeps the module version even when no linker override is supplied.
func buildVersion(override string, info *debug.BuildInfo) string {
	if override != "dev" {
		return override
	}
	if info != nil && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return strings.TrimPrefix(info.Main.Version, "v")
	}
	return override
}
