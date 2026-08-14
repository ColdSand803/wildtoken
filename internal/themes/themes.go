// Package themes discovers external theme packs on disk.
package themes

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"unicode"
)

// Pack is a theme the admin console can offer.
type Pack struct {
	ID          string    `json:"id"`
	Label       string    `json:"label"`
	Swatch      [2]string `json:"swatch"`
	CSS         string    `json:"css"`
	Version     *string   `json:"version"`
	Description *string   `json:"description"`
	Source      string    `json:"source"`
}

type manifest struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	Name        string   `json:"name"`
	CSS         string   `json:"css"`
	Swatch      []string `json:"swatch"`
	Version     *string  `json:"version"`
	Description *string  `json:"description"`
}

// ListPacks reads every valid theme pack under root. A missing root is not an
// error; it simply yields no packs.
func ListPacks(root string) ([]Pack, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return []Pack{}, nil
		}
		return nil, err
	}

	packs := []Pack{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		manifestPath := filepath.Join(root, entry.Name(), "theme.json")
		pack, found, err := readManifest(root, entry.Name(), manifestPath)
		if err != nil {
			slog.Warn("skipping invalid theme pack", "path", manifestPath, "error", err)
			continue
		}
		if found {
			packs = append(packs, pack)
		}
	}

	sort.Slice(packs, func(i, j int) bool {
		if packs[i].Label != packs[j].Label {
			return packs[i].Label < packs[j].Label
		}
		return packs[i].ID < packs[j].ID
	})
	return packs, nil
}

func readManifest(root, dirName, manifestPath string) (Pack, bool, error) {
	text, err := os.ReadFile(manifestPath)
	if err != nil {
		if os.IsNotExist(err) {
			return Pack{}, false, nil
		}
		return Pack{}, false, err
	}

	var decoded manifest
	if err := json.Unmarshal(text, &decoded); err != nil {
		return Pack{}, false, err
	}

	id := strings.TrimSpace(decoded.ID)
	if id != dirName {
		return Pack{}, false, errString("manifest id must match its directory name")
	}
	if !isValidThemeID(id) {
		return Pack{}, false, errString("theme id must use lowercase letters, numbers, and hyphens")
	}

	cssPath, ok := normalizeCSSPath(decoded.CSS)
	if !ok {
		return Pack{}, false, errString("css must be a relative .css path")
	}
	info, err := os.Stat(filepath.Join(root, id, filepath.FromSlash(cssPath)))
	if err != nil {
		return Pack{}, false, err
	}
	if !info.Mode().IsRegular() {
		return Pack{}, false, errString("css path is not a file")
	}

	labelSource := decoded.Label
	if strings.TrimSpace(labelSource) == "" {
		labelSource = decoded.Name
	}

	return Pack{
		ID:          id,
		Label:       cleanText(labelSource, id, 64),
		Swatch:      normalizeSwatch(decoded.Swatch),
		CSS:         "/theme-packs/" + id + "/" + cssPath,
		Version:     optionalText(decoded.Version, 32),
		Description: optionalText(decoded.Description, 160),
		Source:      "external",
	}, true, nil
}

type errString string

func (e errString) Error() string { return string(e) }

// cleanText trims a manifest string, drops control characters, and bounds its
// length, so a hostile manifest cannot inject markup or unbounded text.
func cleanText(value, fallback string, maxChars int) string {
	var cleaned strings.Builder
	count := 0
	for _, character := range strings.TrimSpace(value) {
		if unicode.IsControl(character) {
			continue
		}
		if count >= maxChars {
			break
		}
		cleaned.WriteRune(character)
		count++
	}
	if cleaned.Len() == 0 {
		return fallback
	}
	return cleaned.String()
}

func optionalText(value *string, maxChars int) *string {
	if value == nil {
		return nil
	}
	cleaned := cleanText(*value, "", maxChars)
	if cleaned == "" {
		return nil
	}
	return &cleaned
}

func normalizeSwatch(values []string) [2]string {
	swatch := [2]string{"#f8fafc", "#f97316"}
	for index := range swatch {
		if index < len(values) && isHexColor(values[index]) {
			swatch[index] = values[index]
		}
	}
	return swatch
}

func isHexColor(value string) bool {
	hex, found := strings.CutPrefix(strings.TrimSpace(value), "#")
	if !found {
		return false
	}
	if !slices.Contains([]int{3, 4, 6, 8}, len(hex)) {
		return false
	}
	for _, character := range hex {
		if !isHexDigit(character) {
			return false
		}
	}
	return true
}

func isHexDigit(character rune) bool {
	return character >= '0' && character <= '9' ||
		character >= 'a' && character <= 'f' ||
		character >= 'A' && character <= 'F'
}

func isValidThemeID(value string) bool {
	if value == "" || len(value) > 48 {
		return false
	}
	for index, character := range value {
		switch {
		case index == 0:
			if character < 'a' || character > 'z' {
				return false
			}
		case character >= 'a' && character <= 'z',
			character >= '0' && character <= '9',
			character == '-':
		default:
			return false
		}
	}
	return true
}

// normalizeCSSPath accepts only a relative .css path built from plain segments,
// so a manifest cannot escape its own directory.
func normalizeCSSPath(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" || !strings.HasSuffix(value, ".css") {
		return "", false
	}
	if strings.HasPrefix(value, "/") || strings.Contains(value, `\`) {
		return "", false
	}

	parts := strings.Split(value, "/")
	cleaned := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return "", false
		}
		for _, character := range part {
			switch {
			case character >= 'a' && character <= 'z',
				character >= 'A' && character <= 'Z',
				character >= '0' && character <= '9',
				character == '.', character == '_', character == '-':
			default:
				return "", false
			}
		}
		cleaned = append(cleaned, part)
	}

	if len(cleaned) == 0 {
		return "", false
	}
	return strings.Join(cleaned, "/"), true
}
