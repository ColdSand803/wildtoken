package proxy

import (
	"context"
	"database/sql"
	"encoding/json"
	"math/rand/v2"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// normalizeModelMatch trims whitespace and lowercases a model name.
func normalizeModelMatch(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

type parsedModelName struct {
	original   string
	normalized string
}

type parsedModelMapping struct {
	keyNormalized string
	value         *string
}

// parsedUpstream caches the decoded model fields of one row, so the proxy hot
// path never reparses JSON.
type parsedUpstream struct {
	row           models.UpstreamRow
	modelNames    []parsedModelName
	modelPrefixes []string
	modelMappings []parsedModelMapping
	// groupIDs are the groups this channel serves. A token may only reach a
	// channel that shares its group.
	groupIDs map[int64]bool
}

func newParsedUpstream(row models.UpstreamRow, groupIDs []int64) *parsedUpstream {
	upstream := &parsedUpstream{row: row, groupIDs: make(map[int64]bool, len(groupIDs))}
	for _, groupID := range groupIDs {
		upstream.groupIDs[groupID] = true
	}

	var names []string
	if err := json.Unmarshal([]byte(row.ModelNames), &names); err == nil {
		for _, original := range names {
			upstream.modelNames = append(upstream.modelNames, parsedModelName{
				original:   original,
				normalized: normalizeModelMatch(original),
			})
		}
	}

	var prefixes []string
	if err := json.Unmarshal([]byte(row.ModelPrefixes), &prefixes); err == nil {
		for _, prefix := range prefixes {
			upstream.modelPrefixes = append(upstream.modelPrefixes, normalizeModelMatch(prefix))
		}
	}

	// Mapping values that are not strings are kept as keys with no target, so a
	// malformed entry still scores as an exact match without forwarding a bad name.
	var mappings map[string]json.RawMessage
	if err := json.Unmarshal([]byte(row.ModelMappings), &mappings); err == nil {
		keys := make([]string, 0, len(mappings))
		for key := range mappings {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			mapping := parsedModelMapping{keyNormalized: normalizeModelMatch(key)}
			var target string
			if err := json.Unmarshal(mappings[key], &target); err == nil {
				mapping.value = &target
			}
			upstream.modelMappings = append(upstream.modelMappings, mapping)
		}
	}

	return upstream
}

// routingSnapshot is an immutable view of every enabled upstream.
type routingSnapshot struct {
	upstreams []*parsedUpstream
	byID      map[int64]*parsedUpstream
	byName    map[string]*parsedUpstream
}

func newRoutingSnapshot(rows []models.UpstreamRow, membership map[int64][]int64) *routingSnapshot {
	snapshot := &routingSnapshot{
		byID:   make(map[int64]*parsedUpstream, len(rows)),
		byName: make(map[string]*parsedUpstream, len(rows)),
	}
	for _, row := range rows {
		if row.Enabled != 1 {
			continue
		}
		upstream := newParsedUpstream(row, membership[row.ID])
		snapshot.upstreams = append(snapshot.upstreams, upstream)
		snapshot.byID[row.ID] = upstream
		snapshot.byName[row.Name] = upstream
	}
	return snapshot
}

// RoutingCache holds the parsed enabled-upstream snapshot.
//
// The cache stores parsed model fields so the proxy hot path does not query
// SQLite and reparse JSON on every request. Admin upstream mutations invalidate
// it; the next proxy request reloads from SQLite.
type RoutingCache struct {
	mu       sync.RWMutex
	value    *routingSnapshot
	revision atomic.Uint64
}

func NewRoutingCache() *RoutingCache { return &RoutingCache{} }

func (c *RoutingCache) get() *routingSnapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.value
}

// Invalidate drops the snapshot and advances the revision, so a load already in
// flight cannot publish data that predates this call.
func (c *RoutingCache) Invalidate() {
	c.revision.Add(1)
	c.mu.Lock()
	c.value = nil
	c.mu.Unlock()
}

func (c *RoutingCache) getOrLoad(ctx context.Context, database *sql.DB) (*routingSnapshot, error) {
	for {
		if snapshot := c.get(); snapshot != nil {
			return snapshot, nil
		}

		observedRevision := c.revision.Load()
		rows, err := db.ListEnabledUpstreams(ctx, database)
		if err != nil {
			return nil, err
		}
		membership, err := db.UpstreamGroupMembership(ctx, database)
		if err != nil {
			return nil, err
		}
		loaded := newRoutingSnapshot(rows, membership)

		c.mu.Lock()
		if c.value != nil {
			snapshot := c.value
			c.mu.Unlock()
			return snapshot, nil
		}
		if c.revision.Load() == observedRevision {
			c.value = loaded
			c.mu.Unlock()
			return loaded, nil
		}
		c.mu.Unlock()
	}
}

func (c *RoutingCache) isCached() bool { return c.get() != nil }

// modelMatchScore returns a match score 0–4.
//
//   - 4: exact match in model_mappings or model_names
//   - 3: prefix match in model_prefixes
//   - 2: any non-exact candidate in model_names starts with the requested model
//   - 1: any non-exact candidate in model_names ends with the requested model
//   - 0: no match
func modelMatchScore(upstream *parsedUpstream, model *string) int32 {
	if model == nil {
		return 0
	}
	request := normalizeModelMatch(*model)

	for _, mapping := range upstream.modelMappings {
		if mapping.keyNormalized == request {
			return 4
		}
	}
	for _, name := range upstream.modelNames {
		if name.normalized == request {
			return 4
		}
	}
	for _, prefix := range upstream.modelPrefixes {
		if strings.HasPrefix(request, prefix) {
			return 3
		}
	}

	var best int32
	for _, name := range upstream.modelNames {
		if strings.HasPrefix(name.normalized, request) {
			best = max(best, 2)
		} else if strings.HasSuffix(name.normalized, request) {
			best = max(best, 1)
		}
	}
	return best
}

func matchesModel(upstream *parsedUpstream, model *string) bool {
	return model == nil || modelMatchScore(upstream, model) > 0
}

// selectForwardModel picks the model name sent upstream.
//
//  1. An exact mapping key returns the mapped value.
//  2. Else a model_names candidate that starts with or equals the request.
//  3. Else a model_names candidate that ends with the request.
//  4. Otherwise the original model is forwarded unchanged.
func selectForwardModel(upstream *parsedUpstream, requestedModel *string) *string {
	if requestedModel == nil {
		return nil
	}
	request := normalizeModelMatch(*requestedModel)

	for _, mapping := range upstream.modelMappings {
		if mapping.keyNormalized == request && mapping.value != nil {
			value := *mapping.value
			return &value
		}
	}
	for _, name := range upstream.modelNames {
		if strings.HasPrefix(name.normalized, request) || name.normalized == request {
			original := name.original
			return &original
		}
	}
	for _, name := range upstream.modelNames {
		if name.normalized != "" && strings.HasSuffix(name.normalized, request) {
			original := name.original
			return &original
		}
	}

	forwarded := *requestedModel
	return &forwarded
}

// Selection is the chosen upstream and the model name to forward.
type Selection struct {
	Upstream     models.UpstreamRow
	ForwardModel *string
}

// SelectUpstream chooses the upstream that serves a request.
//
//  1. Direct selection via `x-wildtoken-upstream` header or `upstream` query
//     parameter (the value can be an id or a name).
//  2. Otherwise every enabled upstream is considered.
//  3. Channels in `exclude` are dropped as if disabled — the caller found their
//     rate limit full this round, so re-selection falls over to the rest.
//  4. Candidates are filtered by model match score, keeping only the highest.
//  5. Priority groups are visited from highest to lowest. Within the first group
//     whose total effective weight is positive, one is chosen by weighted random.
func SelectUpstream(
	ctx context.Context,
	database *sql.DB,
	cache *RoutingCache,
	autoWeight *AutoWeightManager,
	policy AutoWeightPolicy,
	upstreamSelector *string,
	model *string,
	groupID int64,
	exclude map[int64]bool,
) (*Selection, error) {
	snapshot, err := cache.getOrLoad(ctx, database)
	if err != nil {
		return nil, err
	}
	return selectFromSnapshot(snapshot, autoWeight, policy, upstreamSelector, model,
		groupID, exclude), nil
}

func selectFromSnapshot(
	snapshot *routingSnapshot,
	autoWeight *AutoWeightManager,
	policy AutoWeightPolicy,
	upstreamSelector *string,
	model *string,
	groupID int64,
	exclude map[int64]bool,
) *Selection {
	if upstreamSelector != nil {
		return selectDirect(snapshot, *upstreamSelector, model, groupID, exclude)
	}
	if len(snapshot.upstreams) == 0 {
		return nil
	}

	// Group isolation is applied before model matching, so a token can never
	// reach a channel outside its group, and a model served only elsewhere reads
	// as "no route" rather than leaking that the channel exists.
	reachable := filterByGroup(snapshot.upstreams, groupID)
	// Exclusion is applied before model scoring for the same reason a disabled
	// channel is: a rate-limited exact match must not shadow a routable prefix
	// match, or skipping the channel would turn into "no route" instead of a
	// failover.
	reachable = filterExcluded(reachable, exclude)
	if len(reachable) == 0 {
		return nil
	}

	candidates := filterByBestModelScore(reachable, model)
	if len(candidates) == 0 {
		return nil
	}

	return selectWeightedByPriority(candidates, autoWeight, policy, model)
}

// selectDirect resolves an explicit selector, which may be an id or a name.
//
// Model matching and group membership both still apply: a selector is a routing
// hint, not a way around the isolation a token's group establishes. Unlike zero
// weight and zero health, an exclusion is honored even here, because it means
// the channel's rate limit already refused this request.
func selectDirect(snapshot *routingSnapshot, selector string, model *string,
	groupID int64, exclude map[int64]bool) *Selection {
	if id, err := strconv.ParseInt(selector, 10, 64); err == nil {
		if upstream, ok := snapshot.byID[id]; ok && !exclude[id] &&
			upstream.servesGroup(groupID) && matchesModel(upstream, model) {
			return &Selection{Upstream: upstream.row, ForwardModel: selectForwardModel(upstream, model)}
		}
	}
	if upstream, ok := snapshot.byName[selector]; ok && !exclude[upstream.row.ID] &&
		upstream.servesGroup(groupID) && matchesModel(upstream, model) {
		return &Selection{Upstream: upstream.row, ForwardModel: selectForwardModel(upstream, model)}
	}
	return nil
}

// filterExcluded drops the channels the caller has ruled out for this request.
func filterExcluded(upstreams []*parsedUpstream, exclude map[int64]bool) []*parsedUpstream {
	if len(exclude) == 0 {
		return upstreams
	}
	kept := make([]*parsedUpstream, 0, len(upstreams))
	for _, upstream := range upstreams {
		if !exclude[upstream.row.ID] {
			kept = append(kept, upstream)
		}
	}
	return kept
}

// servesGroup reports whether a channel is reachable from a group.
func (u *parsedUpstream) servesGroup(groupID int64) bool {
	return u.groupIDs[groupID]
}

// filterByGroup keeps only the channels a group can reach.
func filterByGroup(upstreams []*parsedUpstream, groupID int64) []*parsedUpstream {
	reachable := make([]*parsedUpstream, 0, len(upstreams))
	for _, upstream := range upstreams {
		if upstream.servesGroup(groupID) {
			reachable = append(reachable, upstream)
		}
	}
	return reachable
}

// filterByBestModelScore keeps only the upstreams tied at the highest score.
func filterByBestModelScore(upstreams []*parsedUpstream, model *string) []*parsedUpstream {
	if model == nil {
		return upstreams
	}

	var best int32
	scores := make([]int32, len(upstreams))
	for i, upstream := range upstreams {
		scores[i] = modelMatchScore(upstream, model)
		best = max(best, scores[i])
	}
	if best <= 0 {
		return nil
	}

	candidates := make([]*parsedUpstream, 0, len(upstreams))
	for i, upstream := range upstreams {
		if scores[i] == best {
			candidates = append(candidates, upstream)
		}
	}
	return candidates
}

// selectWeightedByPriority walks priority groups high to low, choosing by
// weighted random within the first group that has any routable weight.
func selectWeightedByPriority(
	candidates []*parsedUpstream,
	autoWeight *AutoWeightManager,
	policy AutoWeightPolicy,
	model *string,
) *Selection {
	byPriority := map[int32][]*parsedUpstream{}
	for _, candidate := range candidates {
		byPriority[candidate.row.Priority] = append(byPriority[candidate.row.Priority], candidate)
	}

	priorities := make([]int32, 0, len(byPriority))
	for priority := range byPriority {
		priorities = append(priorities, priority)
	}
	sort.Slice(priorities, func(i, j int) bool { return priorities[i] > priorities[j] })

	for _, priority := range priorities {
		var selectable []*parsedUpstream
		var weights []uint64
		var total uint64
		for _, candidate := range byPriority[priority] {
			snapshot := autoWeight.Snapshot(candidate.row.ID, candidate.row.Weight,
				candidate.row.AutoWeightEnabled == 1, policy)
			if snapshot.RoutingWeight > 0 {
				selectable = append(selectable, candidate)
				weights = append(weights, snapshot.RoutingWeight)
				total += snapshot.RoutingWeight
			}
		}
		if len(selectable) == 0 {
			continue
		}

		chosen := selectable[weightedIndex(weights, total)]
		return &Selection{Upstream: chosen.row, ForwardModel: selectForwardModel(chosen, model)}
	}

	return nil
}

// weightedIndex picks an index with probability proportional to its weight.
func weightedIndex(weights []uint64, total uint64) int {
	if total == 0 {
		return 0
	}
	target := rand.Uint64N(total)
	for i, weight := range weights {
		if target < weight {
			return i
		}
		target -= weight
	}
	return len(weights) - 1
}
