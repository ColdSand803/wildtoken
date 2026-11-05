package proxy

import (
	"net/http"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/models"
)

func threeKeys() []models.UpstreamKey {
	return []models.UpstreamKey{{ID: 1, APIKey: "a"}, {ID: 2, APIKey: "b"}, {ID: 3, APIKey: "c"}}
}

func pickIDs(t *testing.T, picker *KeyPicker, keys []models.UpstreamKey, refused map[int64]bool, n int) []int64 {
	t.Helper()
	var ids []int64
	for range n {
		key, _, ok := picker.Pick(7, keys, refused)
		if !ok {
			t.Fatal("no key")
		}
		ids = append(ids, key.ID)
	}
	return ids
}

func TestPicksRotateOverTheKeys(t *testing.T) {
	if got := pickIDs(t, NewKeyPicker(), threeKeys(), nil, 4); got[0] != 1 || got[1] != 2 || got[2] != 3 || got[3] != 1 {
		t.Errorf("picks = %v, want 1 2 3 1", got)
	}
}

func TestARefusedKeyIsNeverPickedAgainForTheRequest(t *testing.T) {
	picker := NewKeyPicker()
	for _, id := range pickIDs(t, picker, threeKeys(), map[int64]bool{2: true}, 6) {
		if id == 2 {
			t.Fatal("picked the refused key")
		}
	}
	if _, _, ok := picker.Pick(7, threeKeys(), map[int64]bool{1: true, 2: true, 3: true}); ok {
		t.Error("picked a key with every key refused")
	}
}

// A key sitting out is used only when every other is too.
func TestAKeySittingOutComesLast(t *testing.T) {
	picker := NewKeyPicker()
	picker.Bench(1, 0)
	picker.Bench(2, 0)
	for _, id := range pickIDs(t, picker, threeKeys(), nil, 3) {
		if id != 3 {
			t.Fatalf("picked %d with 3 the only key not sitting out", id)
		}
	}

	picker.Bench(3, 0)
	key, benched, ok := picker.Pick(7, threeKeys(), nil)
	if !ok || !benched {
		t.Errorf("all sitting out: %+v benched=%v ok=%v, want one anyway, flagged", key, benched, ok)
	}
	if picker.HasFresh(threeKeys(), nil) {
		t.Error("reported a fresh key with all three sitting out")
	}
}

func TestACooldownDoublesToItsCapAndASuccessEndsIt(t *testing.T) {
	picker := NewKeyPicker()
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	picker.now = func() time.Time { return now }

	for _, want := range []time.Duration{10, 20, 40, 80, 160, 300, 300} {
		picker.Bench(1, 0)
		if got := picker.Remaining(1); got != want*time.Second {
			t.Fatalf("cooldown %v, want %vs", got, want)
		}
	}
	picker.Bench(1, time.Hour)
	if got := picker.Remaining(1); got != keyCooldownMax {
		t.Errorf("a Retry-After of an hour gave %v, want the 5 min cap", got)
	}

	picker.Clear(1)
	picker.Bench(1, 0)
	if got := picker.Remaining(1); got != 10*time.Second {
		t.Errorf("after a success the next refusal sat out %v, want 10s again", got)
	}
}

func TestRetryAfterReadsSecondsOrADate(t *testing.T) {
	for value, want := range map[string]time.Duration{
		"":     0,
		"30":   30 * time.Second,
		"-5":   0,
		"soon": 0,
	} {
		if got := RetryAfter(map[string]string{"retry-after": value}); got != want {
			t.Errorf("%q: %v, want %v", value, got, want)
		}
	}
	date := time.Now().Add(2 * time.Minute).UTC().Format(http.TimeFormat)
	if got := RetryAfter(map[string]string{"retry-after": date}); got < time.Minute || got > 2*time.Minute {
		t.Errorf("a date two minutes out gave %v", got)
	}
}
