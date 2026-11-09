package client

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"
)

// Download handles an explicit binary export without buffering its credentials
// in memory or allowing an error response to be published as a backup.
func (c *Client) Download(ctx context.Context, method, path string, auth Auth,
	query url.Values, body []byte, out io.Writer) (int64, error) {
	response, err := c.open(ctx, method, path, auth, query, body, false)
	if err != nil {
		return 0, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, err := decode(response)
		return 0, err
	}
	defer response.Body.Close()
	mediaType, _, _ := strings.Cut(response.Header.Get("Content-Type"), ";")
	if !strings.EqualFold(strings.TrimSpace(mediaType), "application/octet-stream") {
		return 0, fmt.Errorf("expected a binary backup response")
	}
	size, err := io.Copy(out, io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return size, err
	}
	if size > maxResponseBytes {
		return size, fmt.Errorf("backup exceeds 256 MiB")
	}
	return size, nil
}
