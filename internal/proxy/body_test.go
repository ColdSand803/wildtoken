package proxy

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"testing"
)

func multipartModelBody(t *testing.T, models ...string) (http.Header, []byte) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, model := range models {
		if err := writer.WriteField("model", model); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.WriteField("prompt", "original prompt"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	headers := http.Header{}
	headers.Set("Content-Type", writer.FormDataContentType())
	return headers, body.Bytes()
}

func TestMultipartModelFieldsCannotDisagree(t *testing.T) {
	headers, body := multipartModelBody(t, "allowed", "forbidden")
	if _, err := RequestModel(headers, body); err == nil {
		t.Fatal("conflicting model fields accepted")
	}
	headers, body = multipartModelBody(t, "allowed", "allowed")
	model, err := RequestModel(headers, body)
	if err != nil || model == nil || *model != "allowed" {
		t.Fatalf("equal model fields refused: %v %v", model, err)
	}
	prepared, err := prepareRequestBody(headers, body, ptrTo("mapped"), "images/edits", nil)
	if err != nil {
		t.Fatal(err)
	}
	boundary, _, _ := requestBoundary(headers)
	reader := multipart.NewReader(bytes.NewReader(prepared), boundary)
	models := 0
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		value, err := io.ReadAll(part)
		if err != nil {
			t.Fatal(err)
		}
		if part.FormName() == "model" {
			models++
			if string(value) != "mapped" {
				t.Errorf("unmapped duplicate: %q", value)
			}
		}
	}
	if models != 2 {
		t.Errorf("model field count=%d", models)
	}
}

func TestMultipartRejectsTruncationAndOversizedModelFields(t *testing.T) {
	headers, body := multipartModelBody(t, "m")
	if _, err := RequestModel(headers, body[:len(body)-12]); err == nil {
		t.Error("truncated multipart accepted")
	}
	headers, body = multipartModelBody(t, string(bytes.Repeat([]byte("m"), maxModelFieldBytes+1)))
	if _, err := RequestModel(headers, body); err == nil {
		t.Error("oversized model field accepted")
	}
}
