package ctl

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/client"
)

var updateFields = map[string]string{
	"upstreams update": "name base_url model_names model_prefixes model_mappings effort_mappings priority weight auto_weight_enabled enabled extra_headers timeout_seconds rate_limit group_ids keys",
	"tokens update":    "name description expires_at group_id rate_limit allowed_models enabled",
	"groups update":    "name description",
	"settings update":  "log_body_keep_count log_retention_days log_body_max_bytes max_retries same_upstream_retry_interval_ms auto_weight_failure_penalty auto_weight_success_increment auto_weight_recovery_increment auto_weight_recovery_interval_seconds proxy_enabled proxy_url default_upstream_timeout_seconds image_storage_max_mb dashboard_multiplier revision",
}

// PUT APIs require complete payloads. Project only writable fields from a fresh
// read, then apply the caller's patch; omission must not clear a key or group.
func updateBody(ctx context.Context, c *client.Client, command Command, path string, body []byte) ([]byte, error) {
	fields, updates := updateFields[command.Name]
	if !updates {
		return body, nil
	}
	patch, err := objectInput(body)
	if err != nil {
		return nil, err
	}
	raw, err := c.Do(ctx, "GET", path, client.Admin, nil, nil)
	if err != nil {
		return nil, err
	}
	current, err := jsonValue(raw)
	if err != nil {
		return nil, err
	}
	object, ok := current.(map[string]any)
	if !ok {
		return nil, errors.New("server returned an invalid record")
	}
	result := map[string]any{}
	allowed := map[string]bool{}
	for _, field := range strings.Fields(fields) {
		allowed[field] = true
		if value, ok := object[field]; ok {
			result[field] = value
		}
	}
	switch command.Name {
	case "tokens update":
		if quota, ok := object["quota"].(map[string]any); ok {
			result["limit_expression"] = quota["limit_expression"]
		}
		allowed["limit_expression"], allowed["token"] = true, true
	case "upstreams update":
		allowed["api_key"], allowed["clear_api_key"], allowed["archived"] = true, true, true
		if _, legacy := patch["api_key"]; legacy {
			if _, explicitKeys := patch["keys"]; !explicitKeys {
				delete(result, "keys")
			}
		}
		if keys, ok := result["keys"].([]any); ok {
			for _, key := range keys {
				if item, ok := key.(map[string]any); ok {
					delete(item, "cooling_seconds")
				}
			}
		}
	}
	for key, value := range patch {
		if !allowed[key] {
			return nil, fmt.Errorf("unknown or read-only update field: %s", key)
		}
		result[key] = value
	}
	return json.Marshal(result)
}

func objectInput(raw []byte) (map[string]any, error) {
	if raw == nil {
		return map[string]any{}, nil
	}
	value, err := jsonValue(raw)
	if err != nil {
		return nil, err
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("input must be a JSON object")
	}
	return object, nil
}

func prepareBody(command Command, body []byte, o options) ([]byte, error) {
	if command.body != "" {
		if body != nil {
			return nil, errors.New("this action has a fixed payload; omit --file and --data")
		}
		return []byte(command.body), nil
	}
	if command.Input && body == nil {
		return nil, errors.New("this command requires --file or --data")
	}
	if command.Method == "GET" || command.Method == "DELETE" {
		if body != nil {
			return nil, errors.New("this command does not accept a body")
		}
		return nil, nil
	}
	object, err := objectInput(body)
	if err != nil {
		return nil, err
	}
	switch command.Name {
	case "upstreams import":
		if _, ok := object["mode"]; !ok {
			object["mode"] = "skip"
		}
	case "upstreams export":
		object["include_api_keys"] = o.showSecrets
	case "config export":
		object["include_secrets"] = o.showSecrets
	case "settings rotate-admin-token":
		object["confirm"] = true
	}
	return json.Marshal(object)
}
