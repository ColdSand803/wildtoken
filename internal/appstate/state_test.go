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
	key := ModelsCacheKey{GroupID: 1}
	cache.Set(key, json.RawMessage(`{"stale":true}`), revision)
	if cache.Get(key) != nil {
		t.Error("a list loaded before the invalidation was cached")
	}

	cache.Set(key, json.RawMessage(`{"fresh":true}`), cache.Revision())
	if cache.Get(key) == nil {
		t.Error("a current list was not cached")
	}
}
