package handlers

import (
	"net/http"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// AdminListGroups returns every group with its channel and token counts.
func AdminListGroups(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		groups, err := db.ListGroups(r.Context(), state.DB)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		apperr.WriteJSON(w, http.StatusOK, groups)
	}
}

func AdminGetGroup(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		group, found, err := db.GetGroup(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !found {
			apperr.WriteError(w, apperr.NotFound("group not found"))
			return
		}
		apperr.WriteJSON(w, http.StatusOK, group)
	}
}

func AdminCreateGroup(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input models.GroupIn
		if err := decodeStrictJSON(r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := input.Validate(); err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		group, err := db.CreateGroup(r.Context(), state.DB, &input)
		if err != nil {
			if isUniqueViolation(err) {
				apperr.WriteError(w, apperr.BadRequest("group name already exists"))
				return
			}
			apperr.WriteError(w, err)
			return
		}
		apperr.WriteJSON(w, http.StatusCreated, group)
	}
}

// AdminUpdateGroup renames a group. The default group keeps its name, because
// operators and documentation refer to it by that name.
func AdminUpdateGroup(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		var input models.GroupIn
		if err := decodeStrictJSON(r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := input.Validate(); err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}
		if id == models.DefaultGroupID && input.Name != db.DefaultGroupName {
			apperr.WriteError(w, apperr.BadRequest("the default group cannot be renamed"))
			return
		}

		group, found, err := db.UpdateGroup(r.Context(), state.DB, id, &input)
		if err != nil {
			if isUniqueViolation(err) {
				apperr.WriteError(w, apperr.BadRequest("group name already exists"))
				return
			}
			apperr.WriteError(w, err)
			return
		}
		if !found {
			apperr.WriteError(w, apperr.NotFound("group not found"))
			return
		}

		// A rename does not change routing, but the console shows group names
		// alongside channels, so its cached view is dropped.
		state.ModelsCache.Invalidate()
		apperr.WriteJSON(w, http.StatusOK, group)
	}
}

// AdminDeleteGroup removes a group, moving its tokens to the default group.
func AdminDeleteGroup(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		deleted, err := db.DeleteGroup(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !deleted {
			apperr.WriteError(w, apperr.NotFound("group not found"))
			return
		}

		// Tokens moved and channel membership was cascaded, so both routing and
		// the advertised model list change.
		state.ModelsCache.Invalidate()
		state.Routing.Invalidate()
		w.WriteHeader(http.StatusNoContent)
	}
}
