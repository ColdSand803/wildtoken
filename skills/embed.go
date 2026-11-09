// Package skills embeds the portable agent instructions shipped with the CLI.
package skills

import (
	"embed"
	"io/fs"
)

//go:embed wildtoken/SKILL.md wildtoken/references/*.md
var files embed.FS

func Files() fs.FS { return files }
