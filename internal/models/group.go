package models

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	GroupNameMaxChars        = 60
	GroupDescriptionMaxChars = 200
)

// DefaultGroupID is the seeded group every channel and token falls back to. It
// is protected from renaming and deletion, because a token whose group vanished
// would silently reach no channel at all.
const DefaultGroupID int64 = 1

// Group scopes which channels a downstream token may reach.
type Group struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
	// UpstreamCount and TokenCount are reported so the console can warn before
	// a deletion that would strand tokens.
	UpstreamCount int64 `json:"upstream_count"`
	TokenCount    int64 `json:"token_count"`
	// IsDefault marks the group the console must not offer to delete.
	IsDefault bool `json:"is_default"`
}

// GroupIn is the create and update payload.
type GroupIn struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// Validate judges the values that will be stored and normalizes them, so the
// description is measured after trimming like the name already was.
func (g *GroupIn) Validate() error {
	name := strings.TrimSpace(g.Name)
	if name == "" || utf8.RuneCountInString(name) > GroupNameMaxChars {
		return ErrString("group name must be between 1 and 60 characters")
	}
	if strings.ContainsFunc(name, unicode.IsControl) {
		return ErrString("group name must not contain control characters")
	}

	description := strings.TrimSpace(g.Description)
	if utf8.RuneCountInString(description) > GroupDescriptionMaxChars {
		return ErrString("group description must be at most 200 characters")
	}
	if strings.ContainsFunc(description, unicode.IsControl) {
		return ErrString("group description must not contain control characters")
	}

	g.Name = name
	g.Description = description
	return nil
}
