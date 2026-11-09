// Package integration generates and merges coding-client provider settings.
package integration

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

type Options struct {
	Tool, Server, Provider, Protocol, TokenEnv, Token string
	Models                                            []string
	ContextWindow, MaxTokens                          int
	Reasoning, Vision, EmbedToken                     bool
}

var providerName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`)
var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func Generate(o Options) (map[string]any, error) {
	if o.Tool != "pi" && o.Tool != "opencode" {
		return nil, errors.New("client must be pi or opencode")
	}
	if !providerName.MatchString(o.Provider) {
		return nil, errors.New("provider ID must contain only letters, digits, _ and -")
	}
	if !envName.MatchString(o.TokenEnv) {
		return nil, errors.New("token environment variable name is invalid")
	}
	base, err := url.Parse(o.Server)
	if err != nil || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" ||
		(base.Scheme != "http" && base.Scheme != "https") {
		return nil, errors.New("invalid server URL")
	}
	if o.Tool == "opencode" && (strings.Contains(o.Server, "{env:") || strings.Contains(o.Server, "{file:")) {
		return nil, errors.New("server URL must not contain OpenCode interpolation")
	}
	if o.ContextWindow < 0 || o.MaxTokens < 0 || (o.ContextWindow > 0 && o.MaxTokens > o.ContextWindow) {
		return nil, errors.New("invalid context/output limits")
	}
	api, npm := "", ""
	switch o.Protocol {
	case "chat":
		api, npm = "openai-completions", "@ai-sdk/openai-compatible"
	case "responses":
		api, npm = "openai-responses", "@ai-sdk/openai"
	case "messages":
		api, npm = "anthropic-messages", "@ai-sdk/anthropic"
	default:
		return nil, errors.New("--protocol must be chat, responses or messages; it is not inferred from model names")
	}
	if len(o.Models) == 0 {
		return nil, errors.New("no models selected")
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, id := range o.Models {
		if o.Tool == "opencode" && (strings.Contains(id, "{env:") || strings.Contains(id, "{file:")) {
			return nil, errors.New("model IDs must not contain OpenCode interpolation")
		}
		if id == "" || len(id) > 500 || strings.ContainsFunc(id, func(r rune) bool { return r < 32 || r == 127 }) {
			return nil, errors.New("invalid model ID")
		}
		if !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	endpoint := strings.TrimRight(o.Server, "/")
	if o.Tool != "pi" || o.Protocol != "messages" {
		endpoint += "/v1"
	}
	key := "$" + o.TokenEnv
	if o.Tool == "opencode" {
		key = "{env:" + o.TokenEnv + "}"
	}
	if o.EmbedToken {
		if o.Token == "" {
			return nil, errors.New("--embed-token requires a downstream credential")
		}
		key = o.Token
		if o.Tool == "pi" {
			key = strings.ReplaceAll(key, "$", "$$")
			if strings.HasPrefix(key, "!") {
				key = "$" + key
			}
		} else if strings.Contains(key, "{env:") || strings.Contains(key, "{file:") {
			return nil, errors.New("this token would be interpreted as OpenCode interpolation; use an environment reference")
		}
	}
	if o.Tool == "pi" {
		models := []any{}
		for _, id := range ids {
			model := map[string]any{"id": id}
			if o.ContextWindow > 0 {
				model["contextWindow"] = o.ContextWindow
			}
			if o.MaxTokens > 0 {
				model["maxTokens"] = o.MaxTokens
			}
			if o.Reasoning {
				model["reasoning"] = true
			}
			if o.Vision {
				model["input"] = []string{"text", "image"}
			}
			models = append(models, model)
		}
		return map[string]any{"providers": map[string]any{o.Provider: map[string]any{
			"baseUrl": endpoint, "api": api, "apiKey": key, "models": models,
		}}}, nil
	}
	models := map[string]any{}
	for _, id := range ids {
		model := map[string]any{"name": id}
		limits := map[string]any{}
		if o.ContextWindow > 0 {
			limits["context"] = o.ContextWindow
		}
		if o.MaxTokens > 0 {
			limits["output"] = o.MaxTokens
		}
		if len(limits) > 0 {
			model["limit"] = limits
		}
		if o.Reasoning {
			model["reasoning"] = true
		}
		if o.Vision {
			model["modalities"] = map[string]any{"input": []string{"text", "image"}, "output": []string{"text"}}
		}
		models[id] = model
	}
	return map[string]any{"provider": map[string]any{o.Provider: map[string]any{
		"npm": npm, "name": fmt.Sprintf("WildToken (%s)", o.Protocol),
		"options": map[string]any{"baseURL": endpoint, "apiKey": key}, "models": models,
	}}}, nil
}
