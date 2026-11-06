package proxy

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
)

func TestResponseCredentialDigestTracksAccountsButNotRequestMetadata(t *testing.T) {
	upstream := models.UpstreamRow{BaseURL: "https://example.test", ExtraHeaders: `{"X-Tenant":"one"}`}
	headers := map[string]string{"authorization": "Bearer key", "x-request-id": "first"}
	first := ResponseCredentialDigest(&upstream, headers)
	headers["x-request-id"] = "second"
	if got := ResponseCredentialDigest(&upstream, headers); got != first {
		t.Fatal("request ID changed account affinity")
	}
	upstream.ExtraHeaders = `{"X-Tenant":"two"}`
	if got := ResponseCredentialDigest(&upstream, headers); got == first {
		t.Fatal("static tenant change kept account affinity")
	}
	upstream.ExtraHeaders = `{"X-Tenant":"one"}`
	headers["authorization"] = "Bearer replacement"
	if got := ResponseCredentialDigest(&upstream, headers); got == first || strings.Contains(got, "replacement") {
		t.Fatal("credential was not represented by a digest")
	}
}

func TestResponseIDsAreRememberedBeforeStreamingThem(t *testing.T) {
	for _, prime := range []bool{false, true} {
		t.Run(map[bool]string{false: "direct read", true: "held stream"}[prime], func(t *testing.T) {
			server := sseUpstream(t, 0,
				"data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_saved\"}}\n\n",
				"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_saved\"}}\n\n")
			h := newProxyHarness(t)
			upstream := models.UpstreamRow{ID: 1, Name: "channel", BaseURL: server.URL, ExtraHeaders: "{}"}
			h.registerUpstream(t, &upstream)
			requestCtx := testRequestContext()
			var remembered []string
			requestCtx.RememberResponse = func(id string) error {
				remembered = append(remembered, id)
				return nil
			}
			prepared, err := PrepareRequest(http.Header{}, &upstream, http.MethodPost, "responses",
				"", nil, []byte(`{"model":"m","stream":true}`), 1024)
			if err != nil {
				t.Fatal(err)
			}
			response, err := ProxyRequest(context.Background(), h.deps, testPolicy(), &upstream, requestCtx, prepared)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if prime && !response.Prime(nil) {
				t.Fatal("prime failed")
			}
			buffer := make([]byte, 4096)
			read, err := response.Body.Read(buffer)
			// The final bytes may arrive together with EOF.
			if (err != nil && !errors.Is(err, io.EOF)) || read == 0 || len(remembered) != 1 || remembered[0] != "resp_saved" {
				t.Fatalf("delivered=%d remembered=%v err=%v", read, remembered, err)
			}
			io.Copy(io.Discard, response.Body)
			if len(remembered) != 1 {
				t.Errorf("same response persisted %d times", len(remembered))
			}
		})
	}
}

func TestResponseAccountStorageFailureDoesNotExposeAnUnboundResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"resp_unbound"}`)
	}))
	defer server.Close()
	h := newProxyHarness(t)
	upstream := models.UpstreamRow{ID: 1, Name: "channel", BaseURL: server.URL, ExtraHeaders: "{}"}
	h.registerUpstream(t, &upstream)
	requestCtx := testRequestContext()
	requestCtx.RememberResponse = func(string) error { return errors.New("database unavailable") }
	prepared, err := PrepareRequest(http.Header{}, &upstream, http.MethodPost, "responses", "", nil, []byte(`{}`), 1024)
	if err != nil {
		t.Fatal(err)
	}
	response, err := ProxyRequest(context.Background(), h.deps, testPolicy(), &upstream, requestCtx, prepared)
	if err == nil || response != nil {
		t.Fatalf("unbound response exposed: response=%v err=%v", response, err)
	}
}
