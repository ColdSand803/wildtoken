package metrics

import (
	"strconv"
	"strings"
	"testing"
)

// lineFor returns the single exposition line beginning with the given prefix.
func lineFor(t *testing.T, rendered, prefix string) string {
	t.Helper()
	var found string
	for _, line := range strings.Split(rendered, "\n") {
		if strings.HasPrefix(line, prefix) {
			if found != "" {
				t.Fatalf("two lines start with %q:\n%s\n%s", prefix, found, line)
			}
			found = line
		}
	}
	if found == "" {
		t.Fatalf("no line starts with %q in:\n%s", prefix, rendered)
	}
	return found
}

// TestTheExpositionIsWellFormed checks the shape a scraper parses.
//
// Written by hand rather than by client_golang, so the format is asserted here
// instead of being inherited: every family needs a HELP and TYPE line, and a
// histogram's +Inf bucket must equal its count or Prometheus rejects the series.
func TestTheExpositionIsWellFormed(t *testing.T) {
	collector := NewPrometheus()
	collector.RecordRequest(7, StatusClass2xx, ProtocolOpenAI, 0.4)
	collector.RecordRequest(7, StatusClass2xx, ProtocolOpenAI, 42)
	collector.RecordTokens(1000, 500, 250, 100, 50)
	collector.SetHealth(7, 95)

	rendered := collector.Render()

	for _, name := range []string{metricRequests, metricDuration, metricTokens,
		metricHealth, metricSeriesDropped} {
		if !strings.Contains(rendered, "# HELP "+name+" ") {
			t.Errorf("no HELP line for %s", name)
		}
		if !strings.Contains(rendered, "# TYPE "+name+" ") {
			t.Errorf("no TYPE line for %s", name)
		}
	}

	// A counter carries its full label set.
	requests := lineFor(t, rendered, metricRequests+"{")
	for _, label := range []string{`upstream_id="7"`, `status_class="2xx"`, `protocol="openai"`} {
		if !strings.Contains(requests, label) {
			t.Errorf("request counter %q is missing %s", requests, label)
		}
	}
	if !strings.HasSuffix(requests, " 2") {
		t.Errorf("request counter = %q, want 2 observations", requests)
	}

	// The +Inf bucket must equal the count. A 42-second observation falls past the
	// 30s bound and into the 60s one, so both totals are 2.
	infinity := lineFor(t, rendered, metricDuration+`_bucket{upstream_id="7",status_class="2xx",protocol="openai",le="+Inf"}`)
	count := lineFor(t, rendered, metricDuration+"_count{")
	if !strings.HasSuffix(infinity, " 2") || !strings.HasSuffix(count, " 2") {
		t.Errorf("+Inf bucket and count disagree:\n%s\n%s", infinity, count)
	}

	// Buckets are cumulative: the 0.5s bound counts the 0.4s observation only.
	half := lineFor(t, rendered, metricDuration+`_bucket{upstream_id="7",status_class="2xx",protocol="openai",le="0.5"}`)
	if !strings.HasSuffix(half, " 1") {
		t.Errorf("le=0.5 bucket = %q, want 1", half)
	}
	// And a later bound includes it, which is what makes them cumulative rather
	// than a per-bucket histogram Prometheus would misread.
	sixty := lineFor(t, rendered, metricDuration+`_bucket{upstream_id="7",status_class="2xx",protocol="openai",le="60"}`)
	if !strings.HasSuffix(sixty, " 2") {
		t.Errorf("le=60 bucket = %q, want both observations", sixty)
	}
}

// TestNoLabelCarriesClientSuppliedText is the high-cardinality regression the
// checklist requires.
//
// A model name arrives in the request body, and a token name and id identify a
// credential. Labelling by any of them lets a caller mint unbounded time series by
// varying one field, and permanently — Prometheus keeps a series long after it stops
// being reported.
func TestNoLabelCarriesClientSuppliedText(t *testing.T) {
	collector := NewPrometheus()
	collector.RecordRequest(1, StatusClass2xx, ProtocolOpenAI, 1)
	collector.RecordTokens(10, 10, 0, 0, 0)
	collector.SetHealth(1, 100)

	rendered := collector.Render()
	for _, forbidden := range []string{"model=", "token_id=", "token_name=", "downstream_token"} {
		if strings.Contains(rendered, forbidden) {
			t.Errorf("the exposition carries a %s label:\n%s", forbidden, rendered)
		}
	}

	// The label names that are allowed, so this test fails if a new one appears
	// rather than silently permitting it.
	allowed := map[string]bool{
		"upstream_id": true, "status_class": true, "protocol": true,
		"type": true, "le": true,
	}
	for _, line := range strings.Split(rendered, "\n") {
		open := strings.Index(line, "{")
		if strings.HasPrefix(line, "#") || open < 0 {
			continue
		}
		labels := line[open+1 : strings.LastIndex(line, "}")]
		for _, pair := range strings.Split(labels, ",") {
			name, _, _ := strings.Cut(pair, "=")
			if !allowed[name] {
				t.Errorf("unexpected label %q in %q", name, line)
			}
		}
	}
}

// TestStatusClassBucketsMatchTheLogSemantics keeps an alert and a console filter
// answering the same question.
func TestStatusClassBucketsMatchTheLogSemantics(t *testing.T) {
	for name, testCase := range map[string]struct {
		status *int32
		want   string
	}{
		"success":          {int32Ptr(200), StatusClass2xx},
		"client error":     {int32Ptr(404), StatusClass4xx},
		"client cancelled": {int32Ptr(499), StatusClass4xx},
		"server error":     {int32Ptr(502), StatusClass5xx},
		"redirect":         {int32Ptr(302), StatusClassOther},
		"informational":    {int32Ptr(100), StatusClassOther},
		"no status at all": {nil, StatusClassNone},
	} {
		t.Run(name, func(t *testing.T) {
			if got := StatusClassOf(testCase.status); got != testCase.want {
				t.Errorf("StatusClassOf = %q, want %q", got, testCase.want)
			}
		})
	}
}

// TestAnUnmeasuredRequestIsCountedButNotTimed: a request whose duration is unknown
// is not a fast request, and folding it in as zero would pull every quantile down.
func TestAnUnmeasuredRequestIsCountedButNotTimed(t *testing.T) {
	collector := NewPrometheus()
	collector.RecordRequest(1, StatusClassNone, ProtocolOpenAI, -1)

	rendered := collector.Render()
	requests := lineFor(t, rendered, metricRequests+"{")
	if !strings.HasSuffix(requests, " 1") {
		t.Errorf("request counter = %q, want the request counted", requests)
	}
	if strings.Contains(rendered, metricDuration+"_count{") {
		t.Errorf("an unmeasured request produced a histogram series:\n%s", rendered)
	}
}

// TestTheCardinalityCapDropsRatherThanEvicts.
//
// Evicting would let a counter go backwards, and a counter that decreases makes
// rate() produce garbage — worse than a missing series, which is at least visibly
// missing. The drop count is exported so a scrape can say the numbers are
// incomplete.
func TestTheCardinalityCapDropsRatherThanEvicts(t *testing.T) {
	collector := NewPrometheus()

	// Fill the map, then push well past it.
	for id := range int64(maxRequestSeries) {
		collector.RecordRequest(id, StatusClass2xx, ProtocolOpenAI, 1)
	}
	first := collector.Render()
	firstLine := lineFor(t, first, metricRequests+`{upstream_id="0",status_class="2xx",protocol="openai"}`)

	for id := int64(maxRequestSeries); id < int64(maxRequestSeries)+50; id++ {
		collector.RecordRequest(id, StatusClass2xx, ProtocolOpenAI, 1)
	}

	second := collector.Render()
	// The existing series is untouched.
	if again := lineFor(t, second, metricRequests+`{upstream_id="0",status_class="2xx",protocol="openai"}`); again != firstLine {
		t.Errorf("an existing series changed when the cap was hit: %q then %q", firstLine, again)
	}
	// And the drop is reported rather than silent.
	dropped := lineFor(t, second, metricSeriesDropped+" ")
	if strings.HasSuffix(dropped, " 0") {
		t.Errorf("series were dropped but the counter reads zero: %q", dropped)
	}

	// An already-known series still increments after the cap, so existing channels
	// keep being measured.
	collector.RecordRequest(0, StatusClass2xx, ProtocolOpenAI, 1)
	third := lineFor(t, collector.Render(), metricRequests+`{upstream_id="0",status_class="2xx",protocol="openai"}`)
	if third == firstLine {
		t.Error("a known series stopped incrementing after the cap was reached")
	}
}

// TestTheDropCounterIsAlwaysPresent: a metric that only appears once something has
// gone wrong cannot be alerted on, because there is nothing to write a rule against
// until it is already too late.
func TestTheDropCounterIsAlwaysPresent(t *testing.T) {
	rendered := NewPrometheus().Render()
	if line := lineFor(t, rendered, metricSeriesDropped+" "); !strings.HasSuffix(line, " 0") {
		t.Errorf("drop counter = %q, want 0 on a fresh collector", line)
	}
}

// TestForgettingAChannelDropsItsSeries: SQLite reuses ids, so a new channel must not
// inherit its predecessor's counters — a jump is indistinguishable from real traffic
// to anything computing a rate.
func TestForgettingAChannelDropsItsSeries(t *testing.T) {
	collector := NewPrometheus()
	collector.RecordRequest(3, StatusClass2xx, ProtocolOpenAI, 1)
	collector.RecordRequest(4, StatusClass2xx, ProtocolOpenAI, 1)
	collector.SetHealth(3, 80)

	collector.ForgetUpstream(3)
	rendered := collector.Render()

	if strings.Contains(rendered, `upstream_id="3"`) {
		t.Errorf("the forgotten channel still has series:\n%s", rendered)
	}
	// The other channel is untouched.
	if !strings.Contains(rendered, `upstream_id="4"`) {
		t.Errorf("forgetting one channel removed another:\n%s", rendered)
	}
}

// TestANilCollectorIsSafe so a harness or probe assembled without metrics needs no
// guard at the call site.
func TestANilCollectorIsSafe(t *testing.T) {
	var collector *Prometheus
	collector.RecordRequest(1, StatusClass2xx, ProtocolOpenAI, 1)
	collector.RecordTokens(1, 1, 1, 1, 1)
	collector.SetHealth(1, 50)
	collector.ForgetUpstream(1)
	if rendered := collector.Render(); rendered != "" {
		t.Errorf("a nil collector rendered %q", rendered)
	}
}

// TestConcurrentRecordingAndRenderingDoNotRace exercises the lock: requests record
// from many goroutines while a scrape renders.
func TestConcurrentRecordingAndRenderingDoNotRace(t *testing.T) {
	collector := NewPrometheus()
	done := make(chan struct{})

	go func() {
		defer close(done)
		for i := range 500 {
			collector.RecordRequest(int64(i%8), StatusClass2xx, ProtocolOpenAI, float64(i%60))
			collector.RecordTokens(10, 5, 1, 1, 1)
			collector.SetHealth(int64(i%8), float64(i%101))
		}
	}()
	for range 200 {
		if rendered := collector.Render(); !strings.Contains(rendered, metricRequests) {
			t.Error("a concurrent scrape produced an incomplete exposition")
		}
	}
	<-done

	// Every observation is accounted for: the counters and the histogram counts
	// must agree, which a lost update would break.
	rendered := collector.Render()
	total := uint64(0)
	for _, line := range strings.Split(rendered, "\n") {
		if !strings.HasPrefix(line, metricRequests+"{") {
			continue
		}
		fields := strings.Fields(line)
		parsed, err := strconv.ParseUint(fields[len(fields)-1], 10, 64)
		if err != nil {
			t.Fatalf("unparseable counter %q: %v", line, err)
		}
		total += parsed
	}
	if total != 500 {
		t.Errorf("request counters sum to %d, want 500: an update was lost", total)
	}
}

func int32Ptr(value int32) *int32 { return &value }
