package client

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestClientNeverFollowsCredentialedRedirects(t *testing.T) {
	var hits atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer target.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	c, err := New(origin.URL, "admin-key", "", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Do(context.Background(), "GET", "/api/admin/system", Admin, nil, nil)
	var response *HTTPError
	if !errors.As(err, &response) || response.Status != 307 || hits.Load() != 0 {
		t.Fatalf("redirect followed: %v hits=%d", err, hits.Load())
	}
}

func TestRemotePlaintextRequiresExplicitPermission(t *testing.T) {
	for _, server := range []string{"http://example.test", "https://user:pass@example.test", "file:///tmp/config", "http://localhost?token=x"} {
		if _, err := New(server, "", "", time.Second, false); err == nil {
			t.Errorf("unsafe server accepted: %s", server)
		}
	}
	if _, err := New("http://example.test", "", "", time.Second, true); err != nil {
		t.Fatal(err)
	}
}

func TestClientKeepsReverseProxyBasePathAndEncodesQueries(t *testing.T) {
	c, err := New("https://example.test/gateway/", "", "", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	value, err := c.URL("/api/admin/logs/", url.Values{"search": {"hello world"}})
	if err != nil || value != "https://example.test/gateway/api/admin/logs/?search=hello+world" {
		t.Fatalf("URL=%q err=%v", value, err)
	}
	if _, err := c.URL("/api/admin/../settings", nil); err == nil {
		t.Fatal("dot segments accepted")
	}
}

func TestSSEParserHandlesMultilineDataAndFinalEvent(t *testing.T) {
	body := ": comment\r\nevent: log\r\nid: 7\r\ndata: {\"count\":\r\ndata: 3}\r\n\r\nevent: done\ndata: [DONE]"
	var events []Event
	if err := ReadEvents(strings.NewReader(body), func(event Event) error { events = append(events, event); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].ID != "7" || events[0].Event != "log" || events[1].Data != "[DONE]" {
		t.Fatalf("events=%+v", events)
	}
}

func TestSSEEventSizeIsBoundedAcrossShortLines(t *testing.T) {
	body := strings.Repeat("data: "+strings.Repeat("x", 1000)+"\n", 9000)
	if err := ReadEvents(strings.NewReader(body), func(Event) error { return nil }); err == nil {
		t.Fatal("unbounded multiline event accepted")
	}
}
