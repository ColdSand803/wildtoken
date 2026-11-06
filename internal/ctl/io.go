package ctl

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/localfile"
	"github.com/liguangsheng/wildtoken/internal/secret"
)

func jsonValue(raw []byte) (any, error) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, errors.New("expected one JSON document")
	}
	return value, nil
}

func redact(value any, headers bool) any {
	switch v := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			lower := strings.ToLower(key)
			private := lower == "token" || lower == "token_plain" || lower == "api_key" ||
				lower == "apikey" || lower == "admin_token" || lower == "credential_hash" || lower == "encryption_key"
			if private || (headers && secret.IsSensitiveHeaderName(key)) {
				if text, ok := item.(string); ok && text != "" {
					out[key] = "[redacted]"
				} else {
					out[key] = item
				}
			} else {
				out[key] = redact(item, lower == "headers" || lower == "extra_headers")
			}
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i := range v {
			out[i] = redact(v[i], headers)
		}
		return out
	case string:
		if parsed, err := url.Parse(v); err == nil && parsed.User != nil {
			parsed.User = url.User("redacted")
			return parsed.String()
		}
		return v
	default:
		return value
	}
}

func encoded(value any, o options) ([]byte, error) {
	// Normalize structs and RawMessage before applying the same redaction policy.
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoded, err := jsonValue(raw)
	if err != nil {
		return nil, err
	}
	if !o.showSecrets {
		decoded = redact(decoded, false)
	}
	if o.json {
		raw, err = json.Marshal(decoded)
	} else {
		raw, err = json.MarshalIndent(decoded, "", "  ")
	}
	return append(raw, '\n'), err
}

func output(w io.Writer, value any, o options) error {
	raw, err := encoded(value, o)
	if err != nil {
		return err
	}
	if o.out != "" {
		if err := localfile.Create(o.out, raw); err != nil {
			return err
		}
		return json.NewEncoder(w).Encode(map[string]string{"output": o.out})
	}
	_, err = w.Write(raw)
	return err
}

func credential(file, environment string) (string, error) {
	if file == "" {
		return strings.TrimSpace(os.Getenv(environment)), nil
	}
	snapshot, err := localfile.Read(file)
	if err != nil {
		return "", err
	}
	if !snapshot.Exists() {
		return "", fmt.Errorf("credential file does not exist: %s", file)
	}
	value := strings.TrimSpace(string(snapshot.Data))
	if value == "" {
		return "", errors.New("credential file is empty")
	}
	return value, nil
}

func input(o options, stdin io.Reader) ([]byte, error) {
	if o.data != "" {
		if !json.Valid([]byte(o.data)) {
			return nil, errors.New("--data must be JSON")
		}
		return []byte(o.data), nil
	}
	if o.file == "" {
		return nil, nil
	}
	if o.file != "-" {
		s, err := localfile.Read(o.file)
		if err != nil {
			return nil, err
		}
		if !s.Exists() {
			return nil, fmt.Errorf("input file does not exist: %s", o.file)
		}
		if len(s.Data) > 4<<20 {
			return nil, errors.New("input exceeds 4 MiB")
		}
		if !json.Valid(s.Data) {
			return nil, errors.New("input file must contain JSON")
		}
		return s.Data, nil
	}
	raw, err := io.ReadAll(io.LimitReader(stdin, 4<<20+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 4<<20 {
		return nil, errors.New("input exceeds 4 MiB")
	}
	if !json.Valid(raw) {
		return nil, errors.New("stdin must contain JSON")
	}
	return raw, nil
}

func checkOutputs(o options) error {
	seen := map[string]bool{}
	for _, path := range []string{o.out, o.secretOut} {
		if path == "" {
			continue
		}
		s, err := localfile.Read(path)
		if err != nil {
			return err
		}
		if s.Exists() {
			return fmt.Errorf("refusing to overwrite %s", path)
		}
		if seen[s.Path] {
			return errors.New("--out and --secret-out resolve to the same file")
		}
		seen[s.Path] = true
	}
	return nil
}

func saveSecret(raw json.RawMessage, path string) error {
	if path == "" {
		return nil
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil {
		return errors.New("response has no single credential")
	}
	for _, name := range []string{"token", "api_key"} {
		if text, ok := value[name].(string); ok && text != "" {
			return localfile.Create(path, []byte(text+"\n"))
		}
	}
	return errors.New("response has no single credential; use token creation/get or upstream credential")
}
