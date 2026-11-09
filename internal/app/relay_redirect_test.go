package app

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/config"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/metrics"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/proxy"
	"github.com/liguangsheng/wildtoken/internal/quota"
)

func TestRelayRedirectsRemainInsideTheAllowedEndpoints(t *testing.T) {
	for _, target := range []string{
		"/tenant/v1/files", "/tenant/v1/responses/%2e%2e/files",
		"/v1/responses/resp_elsewhere", "/tenant/v1/responses/%252e%252e/files",
	} {
		t.Run(target, func(t *testing.T) {
			var escaped atomic.Int64
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/tenant/v1/responses" {
					http.Redirect(w, r, target, http.StatusTemporaryRedirect)
					return
				}
				escaped.Add(1)
			}))
			defer upstream.Close()
			row := models.UpstreamRow{BaseURL: upstream.URL + "/tenant", ExtraHeaders: "{}"}
			prepared, err := proxy.PrepareRequest(http.Header{}, &row, http.MethodPost,
				"responses", "", nil, []byte(`{"model":"m"}`), 1024)
			if err != nil {
				t.Fatal(err)
			}
			client := newHTTPClient(models.DefaultRuntimeSettings)
			// ProxyRequest supplies the relay context consumed by the real client.
			_, err = proxy.ProxyRequest(context.Background(), proxy.Deps{
				HTTPClient:     client,
				AutoWeight:     proxy.NewAutoWeightManager(),
				DefaultTimeout: time.Second,
			}, proxy.AutoWeightPolicy{}, &row, proxy.RequestContext{
				Method: http.MethodPost, Path: "responses",
				HoldFailure: func(proxy.LogEntry) {},
			}, prepared)
			if err == nil || escaped.Load() != 0 {
				t.Errorf("redirect escaped: err=%v hits=%d", err, escaped.Load())
			}
		})
	}
}

func TestAnAllowedRelayRedirectStillWorks(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery == "" {
			http.Redirect(w, r, "/tenant/v1/responses?region=eu", http.StatusTemporaryRedirect)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true}`)
	}))
	defer upstream.Close()
	row := models.UpstreamRow{BaseURL: upstream.URL + "/tenant", ExtraHeaders: "{}"}
	prepared, err := proxy.PrepareRequest(http.Header{}, &row, http.MethodPost,
		"responses", "", nil, []byte(`{}`), 1024)
	if err != nil {
		t.Fatal(err)
	}
	settings := config.Default().Database
	settings.URL = "sqlite::memory:"
	database, err := openDatabase(context.Background(), settings)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := db.Init(context.Background(), database); err != nil {
		t.Fatal(err)
	}
	writer := proxy.NewLogWriter(context.Background(), database, metrics.New(), 1, quota.NewTracker())
	defer writer.Close()
	response, err := proxy.ProxyRequest(context.Background(), proxy.Deps{
		HTTPClient: newHTTPClient(models.DefaultRuntimeSettings),
		AutoWeight: proxy.NewAutoWeightManager(), LogWriter: writer,
		DefaultTimeout: time.Second,
	}, proxy.AutoWeightPolicy{}, &row, proxy.RequestContext{
		Method: http.MethodPost, Path: "responses", HoldFailure: func(proxy.LogEntry) {},
	}, prepared)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	io.Copy(io.Discard, response.Body)
	if response.Status != http.StatusOK {
		t.Errorf("allowed redirect returned %d", response.Status)
	}
}
