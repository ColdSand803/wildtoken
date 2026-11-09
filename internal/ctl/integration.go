package ctl

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/liguangsheng/wildtoken/internal/client"
	"github.com/liguangsheng/wildtoken/internal/integration"
	"github.com/liguangsheng/wildtoken/internal/localfile"
)

func runIntegration(ctx context.Context, c *client.Client, token string, args []string, o options, stdout io.Writer) error {
	if len(args) < 1 || len(args) > 2 {
		return errors.New("usage: clients pi|opencode [plan|export] --protocol chat|responses|messages")
	}
	tool, action := args[0], "plan"
	if tool != "pi" && tool != "opencode" {
		return errors.New("client must be pi or opencode")
	}
	if o.protocol != "chat" && o.protocol != "responses" && o.protocol != "messages" {
		return errors.New("--protocol must be chat, responses or messages")
	}
	if len(args) == 2 {
		action = args[1]
	}
	if action != "plan" && action != "export" {
		return errors.New("client action must be plan or export; use --apply --yes to install a plan")
	}
	if o.file != "" || o.data != "" || o.secretOut != "" {
		return errors.New("client setup does not accept API input or --secret-out")
	}
	if o.apply && (action == "export" || !o.yes) {
		return errors.New("configuration writes require plan --apply --yes")
	}
	if o.provider == "" {
		o.provider = "wildtoken-" + o.protocol
	}
	if o.tokenID != "" {
		selected, err := selectedToken(ctx, c, o.tokenID)
		if err != nil {
			return err
		}
		token = selected
		c.SetToken(token)
	}
	ids := []string(o.models)
	if len(ids) == 0 {
		query, err := queries(o.query)
		if err != nil {
			return err
		}
		raw, err := c.Do(ctx, "GET", "/v1/models", client.Downstream, query, nil)
		if err != nil {
			return err
		}
		var result struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			return err
		}
		for _, model := range result.Data {
			ids = append(ids, model.ID)
		}
	}
	desired, err := integration.Generate(integration.Options{
		Tool: tool, Server: o.server, Provider: o.provider, Protocol: o.protocol,
		Models: ids, TokenEnv: o.tokenEnv, Token: token, EmbedToken: o.embedToken,
		ContextWindow: o.contextWindow, MaxTokens: o.maxTokens, Reasoning: o.reasoning, Vision: o.vision,
	})
	if err != nil {
		return err
	}
	if action == "export" {
		if o.embedToken && o.out == "" && !o.showSecrets {
			return errors.New("exporting a literal token requires a private --out file or explicit --show-secrets")
		}
		o.showSecrets = true // Only this generated fragment, never an existing configuration.
		return output(stdout, desired, o)
	}
	path, err := integration.ConfigPath(tool, o.scope, o.config)
	if err != nil {
		return err
	}
	snapshot, err := localfile.Read(path)
	if err != nil {
		return err
	}
	next, changes, err := integration.Merge(snapshot.Data, desired, o.replace)
	if err != nil {
		return err
	}
	plan := map[string]any{
		"client": tool, "config": path, "resolved_path": snapshot.Path,
		"source_sha256": snapshot.Digest(), "changed_paths": changes, "provider": desired,
		"applied": false, "credential_source": "environment:" + o.tokenEnv,
		"notes": []string{"Unspecified context, output and capabilities use the client's defaults.",
			"Only the selected provider is merged; authentication stores and default-model settings are not changed."},
	}
	if o.embedToken {
		plan["credential_source"] = "literal downstream token"
	}
	if o.apply {
		backup, err := snapshot.Apply(next)
		if err != nil {
			return err
		}
		plan["applied"], plan["backup"] = true, backup
	}
	if !o.embedToken {
		o.showSecrets = true
	}
	if err := output(stdout, plan, o); err != nil {
		return fmt.Errorf("configuration applied=%v, but result output failed: %w", plan["applied"], err)
	}
	return nil
}
