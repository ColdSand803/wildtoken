// Package client calls WildToken's HTTP API without opening its database.
package client

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/liguangsheng/wildtoken/internal/client/driver"
)

type Auth string

const (
	Public     Auth = "public"
	Admin      Auth = "admin"
	Downstream Auth = "downstream"
)

type Client struct {
	http  *driver.HTTP
	admin string
	token string
}

func New(server, admin, token string, timeout time.Duration, allowHTTP bool) (*Client, error) {
	transport, err := driver.New(server, timeout, allowHTTP)
	if err != nil {
		return nil, err
	}
	return &Client{http: transport, admin: admin, token: token}, nil
}

func (c *Client) SetToken(token string) { c.token = token }

func (c *Client) URL(path string, query url.Values) (string, error) { return c.http.URL(path, query) }

type HTTPError struct {
	Status int
	Body   json.RawMessage
}

func (e *HTTPError) Error() string { return fmt.Sprintf("server returned HTTP %d", e.Status) }

func (c *Client) open(ctx context.Context, method, path string, auth Auth, query url.Values,
	body []byte, stream bool) (*http.Response, error) {
	headers := http.Header{"Accept": {"application/json"}}
	switch auth {
	case Admin:
		if c.admin == "" {
			return nil, fmt.Errorf("admin credential is missing; set WILDTOKEN_ADMIN_TOKEN or --admin-token-file")
		}
		headers.Set("x-admin-token", c.admin)
	case Downstream:
		if c.token == "" {
			return nil, fmt.Errorf("downstream credential is missing; set WILDTOKEN_TOKEN, --token-file or --token-id")
		}
		headers.Set("Authorization", "Bearer "+c.token)
	}
	if stream {
		headers.Set("Accept", "text/event-stream")
	}
	return c.http.Do(ctx, method, path, query, headers, body, stream)
}

const maxResponseBytes = 256 << 20

func decode(response *http.Response) (json.RawMessage, error) {
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxResponseBytes {
		return nil, fmt.Errorf("response exceeds 256 MiB")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if !json.Valid(body) {
			body = json.RawMessage(`{"error":"non-JSON server response"}`)
		}
		return nil, &HTTPError{Status: response.StatusCode, Body: body}
	}
	if response.StatusCode == http.StatusNoContent || len(body) == 0 {
		return json.RawMessage(`null`), nil
	}
	if !json.Valid(body) {
		return nil, fmt.Errorf("server response is not JSON")
	}
	return body, nil
}

func (c *Client) Do(ctx context.Context, method, path string, auth Auth, query url.Values,
	body []byte) (json.RawMessage, error) {
	response, err := c.open(ctx, method, path, auth, query, body, false)
	if err != nil {
		return nil, err
	}
	return decode(response)
}

type Event struct {
	Event string `json:"event"`
	ID    string `json:"id,omitempty"`
	Data  any    `json:"data"`
}

func (c *Client) Stream(ctx context.Context, method, path string, auth Auth, query url.Values,
	body []byte, emit func(Event) error) error {
	response, err := c.open(ctx, method, path, auth, query, body, true)
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, err := decode(response)
		return err
	}
	defer response.Body.Close()
	if !strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		return fmt.Errorf("server did not return an event stream")
	}
	return ReadEvents(response.Body, emit)
}

// ReadEvents emits one JSON-ready record per SSE event, including multiline data.
func ReadEvents(reader io.Reader, emit func(Event) error) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), 8<<20)
	event := Event{Event: "message"}
	var data []string
	frameBytes := 0
	flush := func() error {
		frameBytes = 0
		if len(data) == 0 {
			event = Event{Event: "message"}
			return nil
		}
		text := strings.Join(data, "\n")
		var decoded any
		decoder := json.NewDecoder(strings.NewReader(text))
		decoder.UseNumber()
		if decoder.Decode(&decoded) == nil {
			event.Data = decoded
		} else {
			event.Data = text
		}
		err := emit(event)
		event, data = Event{Event: "message"}, nil
		return err
	}
	for scanner.Scan() {
		line := scanner.Text()
		frameBytes += len(line) + 1
		if frameBytes > 8<<20 {
			return fmt.Errorf("SSE event exceeds 8 MiB")
		}
		if line == "" {
			if err := flush(); err != nil {
				return err
			}
			continue
		}
		name, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch name {
		case "event":
			event.Event = value
		case "id":
			event.ID = value
		case "data":
			data = append(data, value)
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return flush()
}
