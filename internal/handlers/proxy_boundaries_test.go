package handlers

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

func TestAccountEndpointsCannotBeReachedThroughDotSegments(t *testing.T) {
	state := proxyRateLimitState(t)
	insertCallerToken(t, state.DB, "caller-token")
	var hits atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/files", func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Write([]byte(`{"account_data":"private-files"}`))
	})
	upstream := httptest.NewServer(mux)
	t.Cleanup(upstream.Close)
	createChannel(t, state, "only", upstream.URL, 100, nil)
	router := proxyRateLimitRouter(state)
	for _, path := range []string{
		"/v1/responses/../files", "/v1/responses/%2e%2e/files",
		"/v1/models/%2e%2e/files", "/v1/responses/%252e%252e/files",
		"/v1/responses/..%5cfiles", "/v1/responses//files",
	} {
		response := proxyCall(router, http.MethodGet, path, "")
		if response.Code != http.StatusNotFound {
			t.Errorf("%s returned %d: %s", path, response.Code, response.Body.String())
		}
	}
	if hits.Load() != 0 {
		t.Errorf("account endpoint received %d requests", hits.Load())
	}
}

func multipartImageCall(t *testing.T, router http.Handler, model string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("model", model); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("prompt", "edit the image"); err != nil {
		t.Fatal(err)
	}
	image, err := writer.CreateFormFile("image", "image.png")
	if err != nil {
		t.Fatal(err)
	}
	image.Write([]byte("\x89PNG\r\n\x1a\n\x00\xff\x01"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/images/edits", &body)
	request.Header.Set("Authorization", "Bearer caller-token")
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func TestMultipartImagesUseModelAllowlistRoutingAndMappings(t *testing.T) {
	state := proxyRateLimitState(t)
	insertCallerToken(t, state.DB, "caller-token")
	if _, err := state.DB.Exec(`UPDATE api_tokens SET allowed_models = '["image-alias"]'`); err != nil {
		t.Fatal(err)
	}
	var hits atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if got := r.FormValue("model"); got != "gpt-image-1" {
			t.Errorf("upstream model = %q", got)
		}
		if got := r.FormValue("prompt"); got != "edit the image" {
			t.Errorf("prompt changed to %q", got)
		}
		file, header, err := r.FormFile("image")
		if err != nil {
			t.Error(err)
			return
		}
		defer file.Close()
		data, err := io.ReadAll(file)
		if err != nil || string(data) != "\x89PNG\r\n\x1a\n\x00\xff\x01" || header.Filename != "image.png" {
			t.Errorf("file changed: name=%q bytes=%q err=%v", header.Filename, data, err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":[]}`))
	}))
	t.Cleanup(upstream.Close)
	input := models.DefaultUpstreamIn()
	input.Name, input.BaseURL = "images", upstream.URL
	input.ModelMappings = map[string]string{"image-alias": "gpt-image-1"}
	if _, err := db.CreateUpstream(context.Background(), state.DB, &input); err != nil {
		t.Fatal(err)
	}
	// A higher-priority text channel must not receive the multipart request.
	wrong, wrongHits := countingUpstream(t)
	createChannel(t, state, "text-only", wrong.URL, 999, nil)
	router := proxyRateLimitRouter(state)
	if response := multipartImageCall(t, router, "image-alias"); response.Code != http.StatusOK {
		t.Fatalf("allowed model returned %d: %s", response.Code, response.Body.String())
	}
	if response := multipartImageCall(t, router, "other-image"); response.Code != http.StatusForbidden {
		t.Errorf("disallowed model returned %d", response.Code)
	}
	if hits.Load() != 1 || wrongHits.Load() != 0 {
		t.Errorf("image hits=%d text hits=%d", hits.Load(), wrongHits.Load())
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/images/edits", strings.NewReader("broken"))
	request.Header.Set("Authorization", "Bearer caller-token")
	request.Header.Set("Content-Type", "multipart/form-data")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Errorf("malformed multipart returned %d", response.Code)
	}
}
