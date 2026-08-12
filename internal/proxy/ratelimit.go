package proxy

import (
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/ratelimit"
)

// UpstreamRateLimitAdmits checks a selected channel's rate limit, recording the
// request when it is admitted.
//
// The expression is parsed on every request, mirroring the token-side check: it
// survived validation at write time, so a parse failure here means the row was
// edited out of band, and the channel is treated as unlimited rather than taken
// out of routing over a config error no caller can fix.
func UpstreamRateLimitAdmits(limiter *ratelimit.Limiter, upstream *models.UpstreamRow) bool {
	if upstream.RateLimit == nil {
		return true
	}
	parsed, err := ratelimit.ParseRateLimit(*upstream.RateLimit)
	if err != nil {
		return true
	}
	return limiter.Check(upstream.ID, parsed)
}
