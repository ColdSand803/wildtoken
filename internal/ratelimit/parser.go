package ratelimit

import (
	"fmt"
	"regexp"
	"strconv"
	"time"
)

// RateLimit represents a parsed rate limit configuration.
type RateLimit struct {
	Requests int64         // Number of requests allowed
	Window   time.Duration // Time window
}

var rateLimitPattern = regexp.MustCompile(`^(\d+)/(\d+)?([smhd])$`)

// ParseRateLimit parses a rate limit expression like "100/m", "1000/h", "50/10s".
// Supported formats:
//   - 100/s  → 100 requests per second
//   - 100/m  → 100 requests per minute
//   - 1000/h → 1000 requests per hour
//   - 10000/d → 10000 requests per day
//   - 50/10s → 50 requests per 10 seconds
//   - 200/5m → 200 requests per 5 minutes
func ParseRateLimit(expr string) (*RateLimit, error) {
	if expr == "" {
		return nil, nil
	}

	matches := rateLimitPattern.FindStringSubmatch(expr)
	if matches == nil {
		return nil, fmt.Errorf("invalid rate limit expression: %s (expected format: 100/m, 1000/h, 50/10s)", expr)
	}

	requests, err := strconv.ParseInt(matches[1], 10, 64)
	if err != nil || requests <= 0 {
		return nil, fmt.Errorf("invalid request count in rate limit: %s", matches[1])
	}

	multiplier := int64(1)
	if matches[2] != "" {
		multiplier, err = strconv.ParseInt(matches[2], 10, 64)
		if err != nil || multiplier <= 0 {
			return nil, fmt.Errorf("invalid time multiplier in rate limit: %s", matches[2])
		}
	}

	unit := matches[3]
	var baseWindow time.Duration
	switch unit {
	case "s":
		baseWindow = time.Second
	case "m":
		baseWindow = time.Minute
	case "h":
		baseWindow = time.Hour
	case "d":
		baseWindow = 24 * time.Hour
	default:
		return nil, fmt.Errorf("invalid time unit: %s (must be s, m, h, or d)", unit)
	}

	return &RateLimit{
		Requests: requests,
		Window:   baseWindow * time.Duration(multiplier),
	}, nil
}
