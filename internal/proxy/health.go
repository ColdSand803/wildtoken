// Package proxy routes downstream requests onto upstream providers.
package proxy

import (
	"math"
	"sync"
	"time"

	"github.com/wildtoken/wildtoken/internal/models"
)

// MaxHealthScore is the score an upstream holds while it has no recent failures.
const MaxHealthScore int64 = 100

// AutoWeightPolicy is the runtime-configurable health adjustment policy.
type AutoWeightPolicy struct {
	FailurePenalty    int64
	SuccessIncrement  int64
	RecoveryIncrement int64
	RecoveryInterval  time.Duration
}

// NewAutoWeightPolicy derives the policy from the operator-editable settings.
func NewAutoWeightPolicy(settings *models.RuntimeSettings) AutoWeightPolicy {
	interval := settings.AutoWeightRecoveryIntervalSeconds
	if interval < 1 {
		interval = 1
	}
	return AutoWeightPolicy{
		FailurePenalty:    settings.AutoWeightFailurePenalty,
		SuccessIncrement:  settings.AutoWeightSuccessIncrement,
		RecoveryIncrement: settings.AutoWeightRecoveryIncrement,
		RecoveryInterval:  time.Duration(interval) * time.Second,
	}
}

type healthState struct {
	score          int64
	lastAdjustedAt time.Time
}

// HealthSnapshot is the routing view of one upstream's health.
type HealthSnapshot struct {
	Score                    int64
	RoutingWeight            uint64
	EffectiveWeight          float64
	RecoveryRemainingSeconds *int64
}

// AutoWeightManager tracks per-upstream health scores in memory.
//
// A missing entry means full health, so an upstream that never fails costs
// nothing to track and recovered entries are dropped again.
type AutoWeightManager struct {
	mu     sync.Mutex
	states map[int64]*healthState
	// now is swappable so tests can advance time without sleeping.
	now func() time.Time
}

func NewAutoWeightManager() *AutoWeightManager {
	return &AutoWeightManager{
		states: map[int64]*healthState{},
		now:    time.Now,
	}
}

// recover credits whole elapsed recovery intervals to the score.
func recoverHealth(state *healthState, policy AutoWeightPolicy, now time.Time) {
	if state.score >= MaxHealthScore || policy.RecoveryIncrement == 0 {
		return
	}
	intervalSeconds := int64(policy.RecoveryInterval / time.Second)
	if intervalSeconds <= 0 {
		return
	}
	elapsed := now.Sub(state.lastAdjustedAt)
	if elapsed < 0 {
		return
	}
	intervals := int64(elapsed/time.Second) / intervalSeconds
	if intervals == 0 {
		return
	}
	state.score = min(state.score+policy.RecoveryIncrement*intervals, MaxHealthScore)
	state.lastAdjustedAt = state.lastAdjustedAt.
		Add(time.Duration(intervalSeconds*intervals) * time.Second)
}

func (m *AutoWeightManager) RecordFailure(upstreamID int64, autoWeightEnabled bool, policy AutoWeightPolicy) {
	if !autoWeightEnabled {
		return
	}
	now := m.now()

	m.mu.Lock()
	defer m.mu.Unlock()

	state, ok := m.states[upstreamID]
	if !ok {
		state = &healthState{score: MaxHealthScore, lastAdjustedAt: now}
		m.states[upstreamID] = state
	}
	recoverHealth(state, policy, now)
	state.score = max(state.score-policy.FailurePenalty, 0)
	if policy.FailurePenalty > 0 {
		// A failure at zero restarts the full recovery interval.
		state.lastAdjustedAt = now
	}
	if state.score == MaxHealthScore {
		delete(m.states, upstreamID)
	}
}

func (m *AutoWeightManager) RecordSuccess(upstreamID int64, autoWeightEnabled bool, policy AutoWeightPolicy) {
	if !autoWeightEnabled {
		return
	}
	now := m.now()

	m.mu.Lock()
	defer m.mu.Unlock()

	state, ok := m.states[upstreamID]
	if !ok {
		return
	}
	recoverHealth(state, policy, now)
	previous := state.score
	state.score = min(state.score+policy.SuccessIncrement, MaxHealthScore)
	if state.score != previous {
		state.lastAdjustedAt = now
	}
	if state.score == MaxHealthScore {
		delete(m.states, upstreamID)
	}
}

// Snapshot reports the routing weight an upstream currently earns.
func (m *AutoWeightManager) Snapshot(upstreamID, weight int64, autoWeightEnabled bool, policy AutoWeightPolicy) HealthSnapshot {
	baseWeight := uint64(max(weight, 0))
	if !autoWeightEnabled {
		return HealthSnapshot{
			Score:           MaxHealthScore,
			RoutingWeight:   baseWeight * uint64(MaxHealthScore),
			EffectiveWeight: float64(max(weight, 0)),
		}
	}

	now := m.now()

	m.mu.Lock()
	defer m.mu.Unlock()

	score := MaxHealthScore
	var recoveryRemaining *int64
	if state, ok := m.states[upstreamID]; ok {
		recoverHealth(state, policy, now)
		score = state.score
		if state.score == 0 && policy.RecoveryIncrement > 0 {
			elapsed := now.Sub(state.lastAdjustedAt)
			remaining := policy.RecoveryInterval - elapsed
			if remaining < 0 {
				remaining = 0
			}
			seconds := int64(math.Ceil(float64(remaining) / float64(time.Second)))
			recoveryRemaining = &seconds
		}
		if state.score == MaxHealthScore {
			delete(m.states, upstreamID)
		}
	}

	return HealthSnapshot{
		Score:                    score,
		RoutingWeight:            baseWeight * uint64(score),
		EffectiveWeight:          float64(max(weight, 0)) * float64(score) / float64(MaxHealthScore),
		RecoveryRemainingSeconds: recoveryRemaining,
	}
}

// Reset drops an upstream's tracked health, restoring it to full.
func (m *AutoWeightManager) Reset(upstreamID int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.states, upstreamID)
}

// setLastAdjustedAt backdates an entry so tests can exercise time recovery.
func (m *AutoWeightManager) setLastAdjustedAt(upstreamID int64, lastAdjustedAt time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if state, ok := m.states[upstreamID]; ok {
		state.lastAdjustedAt = lastAdjustedAt
	}
}
