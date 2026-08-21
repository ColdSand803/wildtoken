package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// Portable configuration migration.
//
// Two properties shape everything here:
//
//  1. Names, not ids. Channels and tokens reference groups by name, because the
//     source instance's numeric ids mean something else on the target — placing a
//     channel in the wrong group would leave routing looking configured while
//     serving the wrong traffic.
//  2. One transaction. A validation failure must leave nothing behind, so the plan
//     is built and applied inside a single transaction and a dry run is that same
//     transaction rolled back. The preview therefore cannot describe an outcome the
//     real import would not produce — including the unique-constraint failures only
//     a real write discovers.

// ExportConfig reads the requested scopes into an archive payload.
func ExportConfig(ctx context.Context, database *sql.DB, scopes []string,
	includeSecrets bool) (*models.ConfigArchivePayload, error) {
	selected := map[string]bool{}
	for _, scope := range scopes {
		selected[scope] = true
	}

	payload := &models.ConfigArchivePayload{
		Groups:   []models.ConfigArchiveGroup{},
		Channels: []models.ConfigArchiveChannel{},
		Tokens:   []models.ConfigArchiveToken{},
	}

	if selected[models.ConfigScopeGroups] {
		groups, err := exportGroups(ctx, database)
		if err != nil {
			return nil, err
		}
		payload.Groups = groups
	}
	if selected[models.ConfigScopeChannels] {
		channels, err := exportChannels(ctx, database, includeSecrets)
		if err != nil {
			return nil, err
		}
		payload.Channels = channels
	}
	if selected[models.ConfigScopeTokens] {
		tokens, err := exportTokens(ctx, database, includeSecrets)
		if err != nil {
			return nil, err
		}
		payload.Tokens = tokens
	}
	if selected[models.ConfigScopeSettings] {
		settings, err := exportSettings(ctx, database)
		if err != nil {
			return nil, err
		}
		payload.Settings = settings
	}
	return payload, nil
}

func exportGroups(ctx context.Context, database *sql.DB) ([]models.ConfigArchiveGroup, error) {
	rows, err := database.QueryContext(ctx,
		"SELECT name, description FROM groups ORDER BY name")
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	groups := []models.ConfigArchiveGroup{}
	for rows.Next() {
		var group models.ConfigArchiveGroup
		if err := rows.Scan(&group.Name, &group.Description); err != nil {
			return nil, apperr.Database(err)
		}
		groups = append(groups, group)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return groups, nil
}

func exportChannels(ctx context.Context, database *sql.DB,
	includeSecrets bool) ([]models.ConfigArchiveChannel, error) {
	rows, err := ListUpstreamRows(ctx, database)
	if err != nil {
		return nil, err
	}
	// One query for the whole membership map rather than per channel: the export
	// is a single consistent read, and a per-channel query would let a group edit
	// land between two channels.
	groupNames, err := upstreamGroupNames(ctx, database)
	if err != nil {
		return nil, err
	}

	channels := make([]models.ConfigArchiveChannel, 0, len(rows))
	for index := range rows {
		out, err := RowToUpstreamOut(&rows[index])
		if err != nil {
			return nil, err
		}
		channel := models.ConfigArchiveChannel{
			Name:              out.Name,
			BaseURL:           out.BaseURL,
			ModelNames:        out.ModelNames,
			ModelPrefixes:     out.ModelPrefixes,
			ModelMappings:     out.ModelMappings,
			Priority:          out.Priority,
			Weight:            out.Weight,
			AutoWeightEnabled: out.AutoWeightEnabled,
			Enabled:           out.Enabled,
			ExtraHeaders:      out.ExtraHeaders,
			TimeoutSeconds:    out.TimeoutSeconds,
			RateLimit:         out.RateLimit,
			GroupNames:        groupNames[out.ID],
		}
		if channel.GroupNames == nil {
			channel.GroupNames = []string{}
		}
		if includeSecrets {
			channel.APIKey = rows[index].APIKey
		}
		channels = append(channels, channel)
	}
	return channels, nil
}

// upstreamGroupNames maps each channel onto the group names it belongs to.
func upstreamGroupNames(ctx context.Context, database *sql.DB) (map[int64][]string, error) {
	rows, err := database.QueryContext(ctx, `SELECT ug.upstream_id, g.name
        FROM upstream_groups ug JOIN groups g ON g.id = ug.group_id
        ORDER BY ug.upstream_id, g.name`)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	membership := map[int64][]string{}
	for rows.Next() {
		var upstreamID int64
		var name string
		if err := rows.Scan(&upstreamID, &name); err != nil {
			return nil, apperr.Database(err)
		}
		membership[upstreamID] = append(membership[upstreamID], name)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return membership, nil
}

func exportTokens(ctx context.Context, database *sql.DB,
	includeSecrets bool) ([]models.ConfigArchiveToken, error) {
	// token_plain is NULL for rows written before it was kept, so a secrets export
	// can be partial. That is reported per token by the caller rather than failing
	// the export: the other tokens are still migratable.
	rows, err := database.QueryContext(ctx, `SELECT t.name, t.description, t.token_plain,
            t.enabled, t.expires_at, g.name, t.limit_tokens, t.rate_limit,
            t.allowed_models, t.quota_period, t.quota_timezone
        FROM api_tokens t JOIN groups g ON g.id = t.group_id
        ORDER BY t.name`)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	tokens := []models.ConfigArchiveToken{}
	for rows.Next() {
		var token models.ConfigArchiveToken
		var enabled int64
		var plaintext, allowedModels *string
		if err := rows.Scan(&token.Name, &token.Description, &plaintext, &enabled,
			&token.ExpiresAt, &token.GroupName, &token.LimitTokens, &token.RateLimit,
			&allowedModels, &token.QuotaPeriod, &token.QuotaTimezone); err != nil {
			return nil, apperr.Database(err)
		}
		token.Enabled = enabled != 0
		// Shared with the token list endpoint, so a whitelist reads the same way in
		// an archive as it does in the console.
		token.AllowedModels = allowedModelsOut(allowedModels)
		if includeSecrets {
			token.Token = plaintext
		}
		tokens = append(tokens, token)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return tokens, nil
}

func exportSettings(ctx context.Context, database *sql.DB) (*models.ConfigArchiveSettings, error) {
	settings, found, err := LoadRuntimeSettings(ctx, database)
	if err != nil {
		return nil, err
	}
	if !found {
		// Nothing stored means the instance is running on startup defaults. Exporting
		// those as if they had been configured would present a default as a decision.
		return nil, nil
	}
	return &models.ConfigArchiveSettings{
		LogBodyKeepCount:                  settings.LogBodyKeepCount,
		LogRetentionDays:                  settings.LogRetentionDays,
		LogBodyMaxBytes:                   settings.LogBodyMaxBytes,
		MaxRetries:                        settings.MaxRetries,
		SameUpstreamRetryIntervalMs:       settings.SameUpstreamRetryIntervalMs,
		AutoWeightFailurePenalty:          settings.AutoWeightFailurePenalty,
		AutoWeightSuccessIncrement:        settings.AutoWeightSuccessIncrement,
		AutoWeightRecoveryIncrement:       settings.AutoWeightRecoveryIncrement,
		AutoWeightRecoveryIntervalSeconds: settings.AutoWeightRecoveryIntervalSeconds,
		ProxyEnabled:                      settings.ProxyEnabled,
		ProxyURL:                          settings.ProxyURL,
		LoadBalanceStrategy:               settings.LoadBalanceStrategy,
	}, nil
}

// ConfigImportOptions is what the caller decides about an import.
type ConfigImportOptions struct {
	OnConflict string
	DryRun     bool
	// Scopes narrows what to apply. Empty means every scope the archive carries.
	Scopes []string
	// DefaultTimeoutSeconds is used for a channel whose archived timeout is absent
	// or non-positive, matching what channel creation does.
	DefaultTimeoutSeconds float64
	// GenerateToken mints a credential for a token the archive carried no secret
	// for. Injected rather than called directly so a test can produce a
	// deterministic value.
	GenerateToken func() (string, error)
}

// ImportConfig applies an archive payload inside one transaction.
//
// The response's item list is built as the work is done, so a dry run reports what
// it actually managed to do before the rollback — not a separate prediction that
// could differ. Anything that fails validation aborts the whole import: the
// checklist requires that a refused archive leave no partial write, and "some of
// your channels imported" is a state an operator cannot reason about.
func ImportConfig(ctx context.Context, database *sql.DB, payload *models.ConfigArchivePayload,
	options ConfigImportOptions) (models.ConfigImportResponse, error) {
	response := models.ConfigImportResponse{
		DryRun: options.DryRun,
		Items:  []models.ConfigImportItem{},
	}

	selected := map[string]bool{}
	if len(options.Scopes) == 0 {
		for _, scope := range models.ConfigScopes {
			selected[scope] = true
		}
	} else {
		for _, scope := range options.Scopes {
			selected[scope] = true
		}
	}

	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return response, apperr.Database(err)
	}
	// Rolled back unless the import both succeeds and is not a dry run. A deferred
	// rollback after a commit is a no-op, so this is safe in every path.
	defer tx.Rollback()

	applier := &configApplier{
		ctx:      ctx,
		tx:       tx,
		options:  options,
		response: &response,
	}

	// Groups first: channels and tokens name them, and a group created later would
	// leave those references unresolvable.
	if selected[models.ConfigScopeGroups] {
		if err := applier.applyGroups(payload.Groups); err != nil {
			return applier.refuse(err)
		}
	}
	if selected[models.ConfigScopeChannels] {
		if err := applier.applyChannels(payload.Channels); err != nil {
			return applier.refuse(err)
		}
	}
	if selected[models.ConfigScopeTokens] {
		if err := applier.applyTokens(payload.Tokens); err != nil {
			return applier.refuse(err)
		}
	}
	if selected[models.ConfigScopeSettings] && payload.Settings != nil {
		if err := applier.applySettings(payload.Settings); err != nil {
			return applier.refuse(err)
		}
	}

	if options.DryRun {
		// Rolled back by the deferred call. Applied stays false, which is what tells
		// the console this was a plan.
		return response, nil
	}
	if err := tx.Commit(); err != nil {
		return response, apperr.Database(err)
	}
	response.Applied = true
	return response, nil
}

// configApplier carries the transaction and accumulates the report.
type configApplier struct {
	ctx      context.Context
	tx       *sql.Tx
	options  ConfigImportOptions
	response *models.ConfigImportResponse
}

// refuse turns a validation failure into a refused import.
//
// The accumulated items are kept: they are how an operator sees which entry the
// archive failed on. Applied stays false and the transaction rolls back, so
// nothing described as done was actually written.
func (a *configApplier) refuse(err error) (models.ConfigImportResponse, error) {
	var refusal *configRefusal
	if !errors.As(err, &refusal) {
		// A database or encoding failure, not a rejected archive. Reported as an
		// error so the handler answers 500 rather than presenting an infrastructure
		// problem as bad input.
		return *a.response, err
	}
	a.response.Failed++
	a.response.Items = append(a.response.Items, models.ConfigImportItem{
		Scope:  refusal.scope,
		Name:   refusal.name,
		Action: models.ConfigImportFail,
		Detail: refusal.reason,
	})
	a.response.Errors = append(a.response.Errors, refusal.Error())
	a.response.Applied = false
	return *a.response, nil
}

// configRefusal is a rejected archive entry, as opposed to an infrastructure
// failure. The distinction is what decides between 400 and 500.
type configRefusal struct {
	scope  string
	name   string
	reason string
}

func (r *configRefusal) Error() string {
	if r.name == "" {
		return r.scope + ": " + r.reason
	}
	return r.scope + " " + r.name + ": " + r.reason
}

func refuse(scope, name, reason string) error {
	return &configRefusal{scope: scope, name: name, reason: reason}
}

func (a *configApplier) record(scope, name, action, detail string) {
	switch action {
	case models.ConfigImportCreate:
		a.response.Created++
	case models.ConfigImportUpdate:
		a.response.Updated++
	case models.ConfigImportSkip:
		a.response.Skipped++
	}
	a.response.Items = append(a.response.Items, models.ConfigImportItem{
		Scope: scope, Name: name, Action: action, Detail: detail,
	})
}

// resolveConflict decides what to do about a name that already exists.
//
// The fail policy is the operator saying "this target should not already have any of
// this" — but every instance is seeded with the default group, so a full archive
// naming it would be refused on a row nobody configured. matches lets a caller say
// the stored definition is already what the archive asks for: there is no conflict
// to fail on, because applying it would change nothing.
func (a *configApplier) resolveConflict(scope, name string, matches bool) (action string, err error) {
	switch a.options.OnConflict {
	case models.ConfigConflictOverwrite:
		return models.ConfigImportUpdate, nil
	case models.ConfigConflictFail:
		if matches {
			return models.ConfigImportSkip, nil
		}
		return "", refuse(scope, name,
			"already exists and the conflict policy is fail")
	default:
		return models.ConfigImportSkip, nil
	}
}

func (a *configApplier) applyGroups(groups []models.ConfigArchiveGroup) error {
	for _, group := range groups {
		input := models.GroupIn{Name: group.Name, Description: group.Description}
		if err := input.Validate(); err != nil {
			return refuse(models.ConfigScopeGroups, group.Name, err.Error())
		}

		id, found, err := a.groupIDByName(input.Name)
		if err != nil {
			return err
		}
		if found {
			// A group is only its name and description, so an equal description means
			// the stored group is already what the archive describes.
			var stored string
			if err := a.tx.QueryRowContext(a.ctx,
				"SELECT COALESCE(description, '') FROM groups WHERE id = ?", id).
				Scan(&stored); err != nil {
				return apperr.Database(err)
			}
			action, err := a.resolveConflict(models.ConfigScopeGroups, input.Name,
				stored == input.Description)
			if err != nil {
				return err
			}
			if action == models.ConfigImportSkip {
				a.record(models.ConfigScopeGroups, input.Name, action, "已存在，保留现有分组")
				continue
			}
			// The default group's name is protected elsewhere; only its description
			// is written here, and the name is what it was matched by anyway.
			if _, err := a.tx.ExecContext(a.ctx,
				"UPDATE groups SET description = ?, updated_at = datetime('now') WHERE id = ?",
				input.Description, id); err != nil {
				return apperr.Database(err)
			}
			a.record(models.ConfigScopeGroups, input.Name, action, "")
			continue
		}

		if _, err := a.tx.ExecContext(a.ctx,
			"INSERT INTO groups (name, description) VALUES (?, ?)",
			input.Name, input.Description); err != nil {
			if IsUniqueViolation(err) {
				return refuse(models.ConfigScopeGroups, input.Name, "group name is already taken")
			}
			return apperr.Database(err)
		}
		a.record(models.ConfigScopeGroups, input.Name, models.ConfigImportCreate, "")
	}
	return nil
}

func (a *configApplier) groupIDByName(name string) (int64, bool, error) {
	var id int64
	err := a.tx.QueryRowContext(a.ctx, "SELECT id FROM groups WHERE name = ?", name).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, apperr.Database(err)
	}
	return id, true, nil
}

// resolveGroupNames turns archived group names into local ids.
//
// A name that does not exist locally is refused rather than silently replaced by
// the default group: a channel quietly placed in the wrong group serves traffic it
// was not meant to, which is the failure this whole format exists to avoid.
func (a *configApplier) resolveGroupNames(scope, owner string, names []string) ([]int64, error) {
	if len(names) == 0 {
		// Matching what channel and token creation do with an empty selection.
		return []int64{models.DefaultGroupID}, nil
	}
	ids := make([]int64, 0, len(names))
	seen := map[int64]bool{}
	for _, name := range names {
		trimmed := strings.TrimSpace(name)
		id, found, err := a.groupIDByName(trimmed)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, refuse(scope, owner, fmt.Sprintf(
				"references group %q, which does not exist on this instance; import the groups scope first",
				trimmed))
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids, nil
}

func (a *configApplier) applyChannels(channels []models.ConfigArchiveChannel) error {
	for index := range channels {
		channel := channels[index]
		timeout := channel.TimeoutSeconds
		if timeout <= 0 {
			timeout = a.options.DefaultTimeoutSeconds
		}
		input := models.UpstreamIn{
			Name:              channel.Name,
			BaseURL:           channel.BaseURL,
			APIKey:            channel.APIKey,
			ModelNames:        channel.ModelNames,
			ModelPrefixes:     channel.ModelPrefixes,
			ModelMappings:     channel.ModelMappings,
			Priority:          channel.Priority,
			Weight:            channel.Weight,
			AutoWeightEnabled: channel.AutoWeightEnabled,
			Enabled:           channel.Enabled,
			ExtraHeaders:      channel.ExtraHeaders,
			TimeoutSeconds:    &timeout,
			RateLimit:         channel.RateLimit,
		}
		if err := input.Validate(); err != nil {
			return refuse(models.ConfigScopeChannels, channel.Name, err.Error())
		}
		groupIDs, err := a.resolveGroupNames(models.ConfigScopeChannels, channel.Name,
			channel.GroupNames)
		if err != nil {
			return err
		}
		input.GroupIDs = groupIDs

		existingID, found, err := a.channelIDByName(input.Name)
		if err != nil {
			return err
		}
		if found {
			// Never treated as already-matching: unlike the seeded default group, a
			// channel that exists under this name was created by someone, so the fail
			// policy should say so rather than assume the definitions agree.
			action, err := a.resolveConflict(models.ConfigScopeChannels, input.Name, false)
			if err != nil {
				return err
			}
			if action == models.ConfigImportSkip {
				a.record(models.ConfigScopeChannels, input.Name, action, "已存在，保留现有渠道")
				continue
			}
			detail, err := a.updateChannel(existingID, &input, channel.APIKey != nil)
			if err != nil {
				return err
			}
			a.record(models.ConfigScopeChannels, input.Name, action, detail)
			continue
		}

		detail := ""
		if channel.APIKey == nil {
			// Stated rather than left to be discovered by a failing request: a channel
			// imported without its key is configured and unusable.
			detail = "归档不含密钥，需在导入后补填 API Key"
		}
		if err := a.insertChannel(&input); err != nil {
			return err
		}
		a.record(models.ConfigScopeChannels, input.Name, models.ConfigImportCreate, detail)
	}
	return nil
}

func (a *configApplier) channelIDByName(name string) (int64, bool, error) {
	var id int64
	err := a.tx.QueryRowContext(a.ctx, "SELECT id FROM upstreams WHERE name = ?", name).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, apperr.Database(err)
	}
	return id, true, nil
}

func (a *configApplier) insertChannel(input *models.UpstreamIn) error {
	modelNames, modelPrefixes, modelMappings, extraHeaders, err := encodeUpstreamCollections(input)
	if err != nil {
		return err
	}
	rateLimit, err := input.NormalizedRateLimit()
	if err != nil {
		return refuse(models.ConfigScopeChannels, input.Name, err.Error())
	}

	result, err := a.tx.ExecContext(a.ctx, `INSERT INTO upstreams
        (name, base_url, api_key, model_names, model_prefixes, model_mappings,
         priority, weight, auto_weight_enabled, enabled, extra_headers, timeout_seconds,
         rate_limit, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
		input.Name, input.BaseURL, input.APIKey, modelNames, modelPrefixes, modelMappings,
		input.Priority, input.Weight, boolToInt64(input.AutoWeightEnabled),
		boolToInt64(input.Enabled), extraHeaders, *input.TimeoutSeconds, rateLimit)
	if err != nil {
		if IsUniqueViolation(err) {
			return refuse(models.ConfigScopeChannels, input.Name, "channel name is already taken")
		}
		return apperr.Database(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return apperr.Database(err)
	}
	return ReplaceUpstreamGroups(a.ctx, a.tx, id, input.GroupIDs)
}

// updateChannel overwrites an existing channel, keeping its key when the archive
// carried none.
//
// Clearing the key on an archive exported without secrets would break a working
// channel as a side effect of a migration that never mentioned credentials.
func (a *configApplier) updateChannel(id int64, input *models.UpstreamIn,
	hasKey bool) (string, error) {
	modelNames, modelPrefixes, modelMappings, extraHeaders, err := encodeUpstreamCollections(input)
	if err != nil {
		return "", err
	}
	rateLimit, err := input.NormalizedRateLimit()
	if err != nil {
		return "", refuse(models.ConfigScopeChannels, input.Name, err.Error())
	}

	detail := ""
	query := `UPDATE upstreams SET base_url = ?, model_names = ?, model_prefixes = ?,
            model_mappings = ?, priority = ?, weight = ?, auto_weight_enabled = ?,
            enabled = ?, extra_headers = ?, timeout_seconds = ?, rate_limit = ?,
            updated_at = datetime('now')
        WHERE id = ?`
	args := []any{input.BaseURL, modelNames, modelPrefixes, modelMappings,
		input.Priority, input.Weight, boolToInt64(input.AutoWeightEnabled),
		boolToInt64(input.Enabled), extraHeaders, *input.TimeoutSeconds, rateLimit, id}

	if hasKey {
		query = strings.Replace(query, "SET base_url = ?", "SET api_key = ?, base_url = ?", 1)
		args = append([]any{input.APIKey}, args...)
	} else {
		detail = "归档不含密钥，已保留现有 API Key"
	}

	if _, err := a.tx.ExecContext(a.ctx, query, args...); err != nil {
		return "", apperr.Database(err)
	}
	if err := ReplaceUpstreamGroups(a.ctx, a.tx, id, input.GroupIDs); err != nil {
		return "", err
	}
	return detail, nil
}

func (a *configApplier) applyTokens(tokens []models.ConfigArchiveToken) error {
	for index := range tokens {
		token := tokens[index]
		name := strings.TrimSpace(token.Name)
		description := strings.TrimSpace(token.Description)
		if err := validateArchiveTokenMetadata(name, description); err != nil {
			return refuse(models.ConfigScopeTokens, token.Name, err.Error())
		}

		expiresAt, err := models.NormalizeExpiresAt(token.ExpiresAt)
		if err != nil {
			return refuse(models.ConfigScopeTokens, name, err.Error())
		}
		rateLimit, err := models.NormalizeRateLimit(token.RateLimit)
		if err != nil {
			return refuse(models.ConfigScopeTokens, name, err.Error())
		}
		allowedModels, err := models.NormalizeAllowedModels(token.AllowedModels)
		if err != nil {
			return refuse(models.ConfigScopeTokens, name, err.Error())
		}
		quotaPeriod, quotaTimezone, err := models.NormalizeQuotaCycle(
			token.QuotaPeriod, token.QuotaTimezone)
		if err != nil {
			return refuse(models.ConfigScopeTokens, name, err.Error())
		}
		if token.LimitTokens != nil && *token.LimitTokens < 0 {
			return refuse(models.ConfigScopeTokens, name, "limit_tokens must not be negative")
		}

		groupIDs, err := a.resolveGroupNames(models.ConfigScopeTokens, name,
			nonEmptyNames(token.GroupName))
		if err != nil {
			return err
		}
		groupID := groupIDs[0]

		record := archiveTokenRecord{
			name: name, description: description, enabled: token.Enabled,
			expiresAt: expiresAt, groupID: groupID, limitTokens: token.LimitTokens,
			rateLimit: rateLimit, allowedModels: allowedModels,
			quotaPeriod: quotaPeriod, quotaTimezone: quotaTimezone,
		}

		existingID, found, err := a.tokenIDByName(name)
		if err != nil {
			return err
		}
		if found {
			// As with channels: an existing token name is somebody's live credential,
			// and the fail policy exists so an operator hears about it.
			action, err := a.resolveConflict(models.ConfigScopeTokens, name, false)
			if err != nil {
				return err
			}
			if action == models.ConfigImportSkip {
				a.record(models.ConfigScopeTokens, name, action, "已存在，保留现有令牌与配额")
				continue
			}
			detail, err := a.updateToken(existingID, record, token.Token)
			if err != nil {
				return err
			}
			a.record(models.ConfigScopeTokens, name, action, detail)
			continue
		}

		detail, err := a.insertToken(record, token.Token)
		if err != nil {
			return err
		}
		a.record(models.ConfigScopeTokens, name, models.ConfigImportCreate, detail)
	}
	return nil
}

// archiveTokenRecord is one token's normalized values, ready to be written.
type archiveTokenRecord struct {
	name          string
	description   string
	enabled       bool
	expiresAt     *string
	groupID       int64
	limitTokens   *int64
	rateLimit     *string
	allowedModels string
	quotaPeriod   string
	quotaTimezone string
}

func (a *configApplier) tokenIDByName(name string) (int64, bool, error) {
	var id int64
	err := a.tx.QueryRowContext(a.ctx, "SELECT id FROM api_tokens WHERE name = ?", name).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, apperr.Database(err)
	}
	return id, true, nil
}

// insertToken writes a new credential, minting a value when the archive had none.
//
// used_tokens starts at zero and the period stamp starts empty, deliberately: the
// counters describe what the source instance served, and carrying them would
// either hand a new instance a spent quota or reset one that should not have been.
func (a *configApplier) insertToken(record archiveTokenRecord,
	archived *string) (string, error) {
	value := ""
	detail := ""
	if archived != nil && strings.TrimSpace(*archived) != "" {
		value = strings.TrimSpace(*archived)
	} else {
		generate := a.options.GenerateToken
		if generate == nil {
			generate = GenerateAPIToken
		}
		generated, err := generate()
		if err != nil {
			return "", err
		}
		value = generated
		// The console must say this: a client configured with the source instance's
		// token will not authenticate against this one, and nothing about the token
		// row would show why.
		detail = "归档不含令牌明文，已生成新令牌，原客户端需更新凭证"
	}

	digest := TokenDigest(value)
	if _, err := a.tx.ExecContext(a.ctx, `INSERT INTO api_tokens
        (name, description, token, token_hash, token_preview, token_plain, enabled,
         expires_at, group_id, used_tokens, limit_tokens, rate_limit, allowed_models,
         quota_period, quota_timezone, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
		record.name, record.description, digest, digest, TokenPreview(value), value,
		boolToInt64(record.enabled), record.expiresAt, record.groupID, record.limitTokens,
		record.rateLimit, record.allowedModels, record.quotaPeriod,
		record.quotaTimezone); err != nil {
		if IsUniqueViolation(err) {
			// Either the name or the credential itself. Both are worth refusing: a
			// duplicate credential would make two rows authenticate as each other.
			return "", refuse(models.ConfigScopeTokens, record.name,
				"token name or value is already taken on this instance")
		}
		return "", apperr.Database(err)
	}
	return detail, nil
}

// updateToken overwrites a token's policy, and its value only when the archive
// carried one.
//
// quota_period_key is deliberately untouched, matching UpdateToken: it records
// which period the stored usage belongs to, and rewriting it would either drop
// real usage or hand back spent quota.
func (a *configApplier) updateToken(id int64, record archiveTokenRecord,
	archived *string) (string, error) {
	detail := ""
	if _, err := a.tx.ExecContext(a.ctx, `UPDATE api_tokens
        SET description = ?, enabled = ?, expires_at = ?, group_id = ?, limit_tokens = ?,
            rate_limit = ?, allowed_models = ?, quota_period = ?, quota_timezone = ?,
            updated_at = datetime('now')
        WHERE id = ?`,
		record.description, boolToInt64(record.enabled), record.expiresAt, record.groupID,
		record.limitTokens, record.rateLimit, record.allowedModels, record.quotaPeriod,
		record.quotaTimezone, id); err != nil {
		return "", apperr.Database(err)
	}

	if archived == nil || strings.TrimSpace(*archived) == "" {
		return "归档不含令牌明文，已保留现有令牌值", nil
	}
	value := strings.TrimSpace(*archived)
	digest := TokenDigest(value)
	if _, err := a.tx.ExecContext(a.ctx, `UPDATE api_tokens
        SET token = ?, token_hash = ?, token_preview = ?, token_plain = ?,
            updated_at = datetime('now')
        WHERE id = ?`,
		digest, digest, TokenPreview(value), value, id); err != nil {
		if IsUniqueViolation(err) {
			return "", refuse(models.ConfigScopeTokens, record.name,
				"the archived token value is already used by another token on this instance")
		}
		return "", apperr.Database(err)
	}
	return detail, nil
}

// applySettings writes the runtime policy row.
//
// The archive's revision is not used — it is the source instance's
// compare-and-swap counter. The local one is read inside this transaction and
// incremented, so a concurrent console edit is still detected.
func (a *configApplier) applySettings(settings *models.ConfigArchiveSettings) error {
	input := models.RuntimeSettingsIn{
		LogBodyKeepCount:                  settings.LogBodyKeepCount,
		LogRetentionDays:                  settings.LogRetentionDays,
		LogBodyMaxBytes:                   settings.LogBodyMaxBytes,
		MaxRetries:                        settings.MaxRetries,
		SameUpstreamRetryIntervalMs:       settings.SameUpstreamRetryIntervalMs,
		AutoWeightFailurePenalty:          settings.AutoWeightFailurePenalty,
		AutoWeightSuccessIncrement:        settings.AutoWeightSuccessIncrement,
		AutoWeightRecoveryIncrement:       settings.AutoWeightRecoveryIncrement,
		AutoWeightRecoveryIntervalSeconds: settings.AutoWeightRecoveryIntervalSeconds,
		ProxyEnabled:                      settings.ProxyEnabled,
		ProxyURL:                          settings.ProxyURL,
		LoadBalanceStrategy:               settings.LoadBalanceStrategy,
		// Set only to satisfy the payload validator's own revision check; the value
		// written comes from the row read below.
		Revision: 1,
	}
	if err := input.Validate(); err != nil {
		return refuse(models.ConfigScopeSettings, "runtime_settings", err.Error())
	}

	var current int64
	err := a.tx.QueryRowContext(a.ctx, "SELECT revision FROM runtime_settings WHERE id = 1").
		Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		// No row means the instance is on startup defaults, which happens on a
		// database whose seed has not run. Inserting is the same outcome as updating
		// from the operator's point of view.
		if _, err := a.tx.ExecContext(a.ctx, `INSERT INTO runtime_settings
            (id, log_body_keep_count, log_retention_days, log_body_max_bytes, max_retries,
             same_upstream_retry_interval_ms, auto_weight_failure_penalty,
             auto_weight_success_increment, auto_weight_recovery_increment,
             auto_weight_recovery_interval_seconds, proxy_enabled, proxy_url,
             load_balance_strategy, revision, updated_at)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`,
			input.LogBodyKeepCount, input.LogRetentionDays, input.LogBodyMaxBytes,
			input.MaxRetries, input.SameUpstreamRetryIntervalMs,
			input.AutoWeightFailurePenalty, input.AutoWeightSuccessIncrement,
			input.AutoWeightRecoveryIncrement, input.AutoWeightRecoveryIntervalSeconds,
			boolToInt64(input.ProxyEnabled), trimSpace(input.ProxyURL),
			input.NormalizedLoadBalanceStrategy()); err != nil {
			return apperr.Database(err)
		}
		a.record(models.ConfigScopeSettings, "runtime_settings", models.ConfigImportCreate, "")
		return nil
	}
	if err != nil {
		return apperr.Database(err)
	}

	if _, err := a.tx.ExecContext(a.ctx, `UPDATE runtime_settings
        SET log_body_keep_count = ?, log_retention_days = ?, log_body_max_bytes = ?,
            max_retries = ?, same_upstream_retry_interval_ms = ?,
            auto_weight_failure_penalty = ?, auto_weight_success_increment = ?,
            auto_weight_recovery_increment = ?, auto_weight_recovery_interval_seconds = ?,
            proxy_enabled = ?, proxy_url = ?, load_balance_strategy = ?,
            revision = revision + 1, updated_at = datetime('now')
        WHERE id = 1 AND revision = ?`,
		input.LogBodyKeepCount, input.LogRetentionDays, input.LogBodyMaxBytes,
		input.MaxRetries, input.SameUpstreamRetryIntervalMs,
		input.AutoWeightFailurePenalty, input.AutoWeightSuccessIncrement,
		input.AutoWeightRecoveryIncrement, input.AutoWeightRecoveryIntervalSeconds,
		boolToInt64(input.ProxyEnabled), trimSpace(input.ProxyURL),
		input.NormalizedLoadBalanceStrategy(), current); err != nil {
		return apperr.Database(err)
	}
	a.record(models.ConfigScopeSettings, "runtime_settings", models.ConfigImportUpdate, "")
	return nil
}

// validateArchiveTokenMetadata applies the same name and description rules token
// creation does, without going through APITokenIn — the archive carries a resolved
// limit rather than the console's expression, so building one would mean
// re-rendering the number as text just to parse it back.
func validateArchiveTokenMetadata(name, description string) error {
	if name == "" || len([]rune(name)) > models.APITokenNameMaxChars {
		return models.ErrString("token name must be between 1 and 80 characters")
	}
	if len([]rune(description)) > models.APITokenDescriptionMaxChars {
		return models.ErrString("token description must be at most 200 characters")
	}
	return nil
}

func nonEmptyNames(values ...string) []string {
	names := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			names = append(names, value)
		}
	}
	return names
}
