package driver

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// HTTP owns transport policy; callers supply only endpoint paths and headers.
type HTTP struct {
	base   *url.URL
	client http.Client
}

func New(server string, timeout time.Duration, allowHTTP bool) (*HTTP, error) {
	base, err := url.Parse(server)
	if err != nil || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" ||
		(base.Scheme != "http" && base.Scheme != "https") {
		return nil, errors.New("server must be an http(s) URL without credentials, query or fragment")
	}
	if base.Scheme == "http" && !allowHTTP {
		host := base.Hostname()
		ip := net.ParseIP(host)
		if !strings.EqualFold(host, "localhost") && (ip == nil || !ip.IsLoopback()) {
			return nil, errors.New("remote HTTP exposes credentials; use HTTPS or --allow-http")
		}
	}
	if timeout < 0 {
		return nil, errors.New("timeout must not be negative")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = timeout
	return &HTTP{base: base, client: http.Client{
		Transport: transport, Timeout: timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func (h *HTTP) URL(path string, query url.Values) (string, error) {
	if !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "?#\\%") {
		return "", errors.New("invalid API path")
	}
	for _, part := range strings.Split(path, "/")[1:] {
		if part == "." || part == ".." {
			return "", errors.New("invalid API path")
		}
	}
	target := *h.base
	target.Path = strings.TrimRight(target.Path, "/") + path
	target.RawPath = ""
	target.RawQuery = query.Encode()
	return target.String(), nil
}

func (h *HTTP) Do(ctx context.Context, method, path string, query url.Values,
	headers http.Header, body []byte, stream bool) (*http.Response, error) {
	target, err := h.URL(path, query)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header = headers.Clone()
	request.Header.Set("User-Agent", "wildtokenctl")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	client := h.client
	if stream {
		client.Timeout = 0
	}
	return client.Do(request)
}
