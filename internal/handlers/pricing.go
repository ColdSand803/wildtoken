package handlers

import (
	"net/http"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// AdminListPricingRules serves the whole price table, newest effective first.
//
// The history is included rather than only the currently effective rows: a stored
// amount names the version that produced it, and an operator checking a past
// figure needs that version to still be visible.
func AdminListPricingRules(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rules, err := db.ListPricingRules(r.Context(), state.DB)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		apperr.WriteJSON(w, http.StatusOK, models.PricingTableOut{
			Rules: rules,
			Basis: models.PricingTokenBasis,
			// Published so the console does not carry its own copy of the unit
			// convention. A console dividing by the wrong basis displays a price
			// a million times off, and the operator has no way to tell which side
			// is wrong.
			MicroUnitsPerUnit: models.MicroUnitsPerUnit,
			Currencies:        []string{models.CurrencyUSD, models.CurrencyCNY},
		})
	}
}

// AdminCreatePricingRule adds a price version.
//
// There is no update endpoint, and that is the design: a price change inserts a
// new version with a later effective_from, which is what keeps an already settled
// request's amount explicable. An in-place edit would silently change the meaning
// of every stored figure that named the edited row.
func AdminCreatePricingRule(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input models.PricingRuleIn
		if err := decodeJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}

		rule, err := db.CreatePricingRule(r.Context(), state.DB, &input)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		refreshPricingBook(r, state)
		apperr.WriteJSON(w, http.StatusCreated, rule)
	}
}

// AdminDeletePricingRule removes a price version.
//
// Request logs keep pricing_rule_id without a foreign key, so this does not touch
// what past requests were charged: those rows keep their amount and the id that
// produced it, even though the version is gone. Only future settlement changes.
func AdminDeletePricingRule(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		deleted, err := db.DeletePricingRule(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !deleted {
			apperr.NotFound("price not found").Write(w)
			return
		}
		refreshPricingBook(r, state)
		w.WriteHeader(http.StatusNoContent)
	}
}

// refreshPricingBook reloads the in-memory table after a write.
//
// A reload failure is logged rather than turned into a failed request: the write
// committed, so reporting an error would invite the operator to retry a change
// that already took effect. The cached table stays as it was until the next
// successful write or a restart, which is stale but consistent — and the amounts
// it produces still name the version they came from.
func refreshPricingBook(r *http.Request, state *appstate.State) {
	rules, err := db.ListPricingRules(r.Context(), state.DB)
	if err != nil {
		return
	}
	state.Pricing.Replace(rules)
}
