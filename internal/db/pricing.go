package db

import (
	"context"
	"database/sql"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/models"
)

const pricingColumns = `id, model_pattern, currency,
    prompt_micros, completion_micros, cache_read_micros, cache_create_micros,
    effective_from, created_at`

func scanPricingRule(row interface{ Scan(...any) error }) (models.PricingRule, error) {
	var rule models.PricingRule
	err := row.Scan(&rule.ID, &rule.ModelPattern, &rule.Currency,
		&rule.PromptMicros, &rule.CompletionMicros, &rule.CacheReadMicros,
		&rule.CacheCreateMicros, &rule.EffectiveFrom, &rule.CreatedAt)
	return rule, err
}

// ListPricingRules returns every price version, newest effective first.
//
// The whole table is returned rather than only the currently effective rows: the
// console shows the history, and the settlement path needs the versions that were
// in force at the time of each request it prices, not only the latest.
func ListPricingRules(ctx context.Context, db Queryer) ([]models.PricingRule, error) {
	rows, err := db.QueryContext(ctx,
		"SELECT "+pricingColumns+" FROM model_prices ORDER BY effective_from DESC, id DESC")
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	rules := []models.PricingRule{}
	for rows.Next() {
		rule, err := scanPricingRule(rows)
		if err != nil {
			return nil, apperr.Database(err)
		}
		rules = append(rules, rule)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return rules, nil
}

// CreatePricingRule adds a price version.
//
// There is no update: a price change is a new version, so the amount an already
// settled request was charged stays explicable. The console's "edit" is an insert
// with a later effective_from.
func CreatePricingRule(ctx context.Context, db *sql.DB,
	input *models.PricingRuleIn) (models.PricingRule, error) {
	if err := input.Validate(); err != nil {
		return models.PricingRule{}, apperr.BadRequest(err.Error())
	}
	effectiveFrom := input.NormalizedEffectiveFrom()

	result, err := db.ExecContext(ctx, `INSERT INTO model_prices
        (model_pattern, currency, prompt_micros, completion_micros,
         cache_read_micros, cache_create_micros, effective_from)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
		input.ModelPattern, input.Currency, input.PromptMicros, input.CompletionMicros,
		input.CacheReadMicros, input.CacheCreateMicros, effectiveFrom)
	if err != nil {
		return models.PricingRule{}, apperr.Database(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return models.PricingRule{}, apperr.Database(err)
	}

	rule, ok, err := GetPricingRule(ctx, db, id)
	if err != nil {
		return models.PricingRule{}, err
	}
	if !ok {
		return models.PricingRule{}, apperr.Internal("price was not persisted")
	}
	return rule, nil
}

// GetPricingRule reads one version.
func GetPricingRule(ctx context.Context, db Queryer, id int64) (models.PricingRule, bool, error) {
	rule, err := scanPricingRule(db.QueryRowContext(ctx,
		"SELECT "+pricingColumns+" FROM model_prices WHERE id = ?", id))
	if err == sql.ErrNoRows {
		return models.PricingRule{}, false, nil
	}
	if err != nil {
		return models.PricingRule{}, false, apperr.Database(err)
	}
	return rule, true, nil
}

// DeletePricingRule removes a version.
//
// Request logs keep pricing_rule_id without a foreign key, so deleting a version
// leaves already settled amounts intact: the row still records what it was charged
// and which version id produced it. Only future requests are affected.
func DeletePricingRule(ctx context.Context, db *sql.DB, id int64) (bool, error) {
	result, err := db.ExecContext(ctx, "DELETE FROM model_prices WHERE id = ?", id)
	if err != nil {
		return false, apperr.Database(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, apperr.Database(err)
	}
	return affected > 0, nil
}
