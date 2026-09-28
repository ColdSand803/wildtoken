package appstate

import (
	"encoding/json"
	"testing"
)

// A list loaded before an invalidation predates the write that caused it.
// Stored anyway, it stayed until the next write.
func TestAListLoadedBeforeAnInvalidationIsNotCached(t *testing.T) {
	cache := NewModelsListCache()

	revision := cache.Revision()
	cache.Invalidate()
	cache.Set(1, json.RawMessage(`{"stale":true}`), revision)
	if cache.Get(1) != nil {
		t.Error("a list loaded before the invalidation was cached")
	}

	cache.Set(1, json.RawMessage(`{"fresh":true}`), cache.Revision())
	if cache.Get(1) == nil {
		t.Error("a current list was not cached")
	}
}
