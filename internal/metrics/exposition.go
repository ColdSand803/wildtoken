package metrics

import (
	"sort"
	"strconv"
	"strings"
)

// Metric names. Prefixed and suffixed by Prometheus convention: `_total` for a
// counter, base unit in the name for a histogram (`_seconds`, not `_ms`).
const (
	metricRequests      = "wildtoken_http_requests_total"
	metricDuration      = "wildtoken_http_request_duration_seconds"
	metricTokens        = "wildtoken_tokens_total"
	metricHealth        = "wildtoken_upstream_health_status"
	metricSeriesDropped = "wildtoken_metrics_series_dropped_total"
)

// Render writes the exposition format.
//
// Series are emitted in a stable sorted order. Prometheus does not require it, but
// a scrape that reorders on every poll is unreadable when an operator curls the
// endpoint to see what is wrong, and it makes the format tests assert on content
// rather than on set membership.
func (p *Prometheus) Render() string {
	if p == nil {
		return ""
	}

	p.mu.Lock()
	requests := make(map[requestKey]uint64, len(p.requests))
	for key, value := range p.requests {
		requests[key] = value
	}
	durations := make(map[requestKey]histogram, len(p.durations))
	for key, value := range p.durations {
		durations[key] = *value
	}
	tokens := make(map[string]uint64, len(p.tokens))
	for kind, value := range p.tokens {
		tokens[kind] = value
	}
	health := make(map[int64]float64, len(p.health))
	for id, value := range p.health {
		health[id] = value
	}
	dropped := p.seriesDropped
	p.mu.Unlock()

	out := &strings.Builder{}

	out.WriteString("# HELP " + metricRequests +
		" Total upstream attempts by channel, status class and protocol.\n")
	out.WriteString("# TYPE " + metricRequests + " counter\n")
	for _, key := range sortedRequestKeys(requests) {
		out.WriteString(metricRequests + requestLabels(key) + " " +
			strconv.FormatUint(requests[key], 10) + "\n")
	}

	out.WriteString("# HELP " + metricDuration +
		" Upstream attempt duration in seconds.\n")
	out.WriteString("# TYPE " + metricDuration + " histogram\n")
	for _, key := range sortedRequestKeys(durations) {
		writeHistogram(out, key, durations[key])
	}

	out.WriteString("# HELP " + metricTokens +
		" Total tokens by usage dimension.\n")
	out.WriteString("# TYPE " + metricTokens + " counter\n")
	kinds := make([]string, 0, len(tokens))
	for kind := range tokens {
		kinds = append(kinds, kind)
	}
	sort.Strings(kinds)
	for _, kind := range kinds {
		out.WriteString(metricTokens + `{type="` + escapeLabelValue(kind) + `"} ` +
			strconv.FormatUint(tokens[kind], 10) + "\n")
	}

	out.WriteString("# HELP " + metricHealth +
		" Current routing health score per channel, 0 to 100.\n")
	out.WriteString("# TYPE " + metricHealth + " gauge\n")
	healthIDs := make([]int64, 0, len(health))
	for id := range health {
		healthIDs = append(healthIDs, id)
	}
	sort.Slice(healthIDs, func(i, j int) bool { return healthIDs[i] < healthIDs[j] })
	for _, id := range healthIDs {
		out.WriteString(metricHealth + `{upstream_id="` + strconv.FormatInt(id, 10) + `"} ` +
			formatFloat(health[id]) + "\n")
	}

	// Always emitted, including at zero. A metric that only appears once something
	// has gone wrong cannot be alerted on: there is nothing to write a rule against
	// until it is already too late.
	out.WriteString("# HELP " + metricSeriesDropped +
		" Series refused at the cardinality cap; non-zero means these metrics are incomplete.\n")
	out.WriteString("# TYPE " + metricSeriesDropped + " counter\n")
	out.WriteString(metricSeriesDropped + " " + strconv.FormatUint(dropped, 10) + "\n")

	return out.String()
}

// writeHistogram emits one series' buckets, sum and count.
//
// Bucket values are cumulative — le="1" counts everything at or below one second,
// not just what fell between the previous bound and this one. The observation path
// stores per-bucket counts, so the running total is accumulated here.
func writeHistogram(out *strings.Builder, key requestKey, bucket histogram) {
	labels := requestLabelPairs(key)

	cumulative := uint64(0)
	for index, bound := range durationBuckets {
		cumulative += bucket.counts[index]
		out.WriteString(metricDuration + "_bucket" +
			joinLabels(append(labels, `le="`+formatFloat(bound)+`"`)) + " " +
			strconv.FormatUint(cumulative, 10) + "\n")
	}
	// The +Inf bucket must equal the count, which is what makes the histogram
	// well formed.
	cumulative += bucket.counts[durationBucketCount]
	out.WriteString(metricDuration + "_bucket" +
		joinLabels(append(labels, `le="+Inf"`)) + " " +
		strconv.FormatUint(cumulative, 10) + "\n")

	out.WriteString(metricDuration + "_sum" + joinLabels(labels) + " " +
		formatFloat(bucket.sum) + "\n")
	out.WriteString(metricDuration + "_count" + joinLabels(labels) + " " +
		strconv.FormatUint(bucket.total, 10) + "\n")
}

func requestLabelPairs(key requestKey) []string {
	return []string{
		`upstream_id="` + strconv.FormatInt(key.upstreamID, 10) + `"`,
		`status_class="` + escapeLabelValue(key.statusClass) + `"`,
		`protocol="` + escapeLabelValue(key.protocol) + `"`,
	}
}

func requestLabels(key requestKey) string {
	return joinLabels(requestLabelPairs(key))
}

func joinLabels(pairs []string) string {
	if len(pairs) == 0 {
		return ""
	}
	return "{" + strings.Join(pairs, ",") + "}"
}

// escapeLabelValue applies the escaping the text format requires.
//
// Every label value written here comes from a closed set of constants, so nothing
// currently needs escaping. It is applied anyway: the cost is nothing, and the
// alternative is that the first label value drawn from data produces a scrape
// Prometheus rejects, with the failure surfacing as an unrelated target going down.
func escapeLabelValue(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return replacer.Replace(value)
}

// formatFloat renders a float the way the text format expects: no exponent for
// ordinary magnitudes, and the shortest representation that round-trips.
func formatFloat(value float64) string {
	return strconv.FormatFloat(value, 'g', -1, 64)
}

// sortedRequestKeys orders series deterministically by channel, then status, then
// protocol.
func sortedRequestKeys[V any](series map[requestKey]V) []requestKey {
	keys := make([]requestKey, 0, len(series))
	for key := range series {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].upstreamID != keys[j].upstreamID {
			return keys[i].upstreamID < keys[j].upstreamID
		}
		if keys[i].statusClass != keys[j].statusClass {
			return keys[i].statusClass < keys[j].statusClass
		}
		return keys[i].protocol < keys[j].protocol
	})
	return keys
}
