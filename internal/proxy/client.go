package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/metrics"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// attemptTimeout bounds one upstream attempt and reports whether it was the
// thing that ended it.
//
// The bound is on silence, not on total duration. A deadline over the whole
// attempt cut off streaming answers for the offence of being long, which is
// exactly what a reasoning model produces; each chunk that arrives restarts the
// clock, so what remains bounded is "the upstream stopped sending".
//
// Knowing whether the clock ran out is what separates a gateway timeout from a
// client that walked away, since both reach the read as a cancelled context.
type attemptTimeout struct {
	cancel  context.CancelFunc
	timer   *time.Timer
	window  time.Duration
	expired atomic.Bool
}

func newAttemptTimeout(cancel context.CancelFunc, window time.Duration) *attemptTimeout {
	timeout := &attemptTimeout{cancel: cancel, window: window}
	timeout.timer = time.AfterFunc(window, func() {
		// Recorded before cancelling, so a reader woken by the cancellation
		// always sees the reason for it.
		timeout.expired.Store(true)
		cancel()
	})
	return timeout
}

// extend restarts the clock after the upstream made progress.
func (t *attemptTimeout) extend() { t.timer.Reset(t.window) }

// Expired reports whether this timeout ended the attempt.
func (t *attemptTimeout) Expired() bool { return t.expired.Load() }

// stop releases the timer and the attempt's context.
func (t *attemptTimeout) stop() {
	t.timer.Stop()
	t.cancel()
}

// BuildUpstreamURL builds the full upstream URL for a proxied path.
func BuildUpstreamURL(upstream *models.UpstreamRow, path, queryParams string) string {
	base := strings.TrimRight(upstream.BaseURL, "/")
	suffix := strings.TrimLeft(path, "/")

	// A base that already ends in /v1 is not given a second one.
	target := base + "/v1/" + suffix
	if strings.HasSuffix(base, "/v1") {
		target = base + "/" + suffix
	}
	if queryParams != "" {
		target += "?" + queryParams
	}
	return target
}

// ExtractReasoningEffort reads the requested effort from an OpenAI- or
// Anthropic-compatible request body.
//
// It supports the top-level reasoning_effort (chat completions and the o-series),
// the nested reasoning.effort (Responses API style), and the nested
// output_config.effort (Anthropic Messages API style).
func ExtractReasoningEffort(body []byte) *string {
	var request jsonValue
	if err := json.Unmarshal(body, &request); err != nil {
		return nil
	}

	if effort, ok := formatEffort(request["reasoning_effort"]); ok {
		return &effort
	}
	for _, keys := range [][]string{{"reasoning", "effort"}, {"output_config", "effort"}} {
		if text, ok := valueAt(request, keys...).(string); ok {
			if trimmed := strings.TrimSpace(text); trimmed != "" {
				return &trimmed
			}
		}
	}
	return nil
}

// PrepareUpstreamBody rewrites a JSON request body for its selected upstream.
//
// Streaming Chat Completions responses omit usage by default on many
// OpenAI-compatible upstreams. It is requested explicitly so the gateway can
// consistently record prompt, completion, and total token counts.
func PrepareUpstreamBody(body []byte, forwardModel *string, path string) []byte {
	var request map[string]json.RawMessage
	if err := json.Unmarshal(body, &request); err != nil {
		return body
	}

	changed := false

	if forwardModel != nil {
		var currentModel string
		if err := json.Unmarshal(request["model"], &currentModel); err == nil &&
			currentModel != *forwardModel {
			encoded, err := json.Marshal(*forwardModel)
			if err == nil {
				request["model"] = encoded
				changed = true
			}
		}
	}

	if strings.Trim(path, "/") == "chat/completions" && requestsStreaming(request) {
		streamOptions := map[string]json.RawMessage{}
		if raw, present := request["stream_options"]; present {
			if err := json.Unmarshal(raw, &streamOptions); err != nil {
				// A non-object stream_options is replaced rather than merged.
				streamOptions = map[string]json.RawMessage{}
				changed = true
			}
		}
		if !bytes.Equal(streamOptions["include_usage"], []byte("true")) {
			streamOptions["include_usage"] = json.RawMessage("true")
			changed = true
		}
		if encoded, err := json.Marshal(streamOptions); err == nil {
			request["stream_options"] = encoded
		}
	}

	if !changed {
		return body
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return body
	}
	return encoded
}

func requestsStreaming(request map[string]json.RawMessage) bool {
	var stream bool
	return json.Unmarshal(request["stream"], &stream) == nil && stream
}

// PreparedRequest is everything derived from one attempt's request: the URL,
// headers, upstream body, and their log snapshots.
//
// It is computed once and shared by the caller's abort-log fallback and the
// real upstream call, instead of each redoing the same JSON parsing and
// truncation work.
type PreparedRequest struct {
	URL                string
	ForwardHeaders     map[string]string
	UpstreamBody       []byte
	ReasoningEffort    *string
	DownstreamSnapshot json.RawMessage
	UpstreamSnapshot   json.RawMessage
}

// PrepareRequest resolves one attempt against its selected upstream.
func PrepareRequest(downstreamHeaders http.Header, upstream *models.UpstreamRow,
	method, path, queryParams string, forwardModel *string, body []byte,
	logBodyMaxBytes int) (*PreparedRequest, error) {
	url := BuildUpstreamURL(upstream, path, queryParams)
	forwardHeaders, err := BuildForwardHeaders(downstreamHeaders, upstream, path)
	if err != nil {
		return nil, err
	}

	upstreamBody := PrepareUpstreamBody(body, forwardModel, path)

	return &PreparedRequest{
		URL:             url,
		ForwardHeaders:  forwardHeaders,
		UpstreamBody:    upstreamBody,
		ReasoningEffort: ExtractReasoningEffort(body),
		DownstreamSnapshot: SnapshotRequest(method, url, forwardHeaders, body,
			logBodyMaxBytes),
		UpstreamSnapshot: SnapshotRequest(method, url, forwardHeaders, upstreamBody,
			logBodyMaxBytes),
	}, nil
}

// Response is a proxied upstream response. Body must always be closed.
type Response struct {
	Status  int
	Headers map[string]string
	Body    io.ReadCloser
}

// Deps are the shared services a proxied request needs.
type Deps struct {
	HTTPClient *http.Client
	AutoWeight *AutoWeightManager
	Metrics    *metrics.Runtime
	LogWriter  *LogWriter
	// Latency collects the rolling measurements least-latency routing ranks by.
	// It may be nil, which every method on it tolerates: a caller that does not
	// route — an admin probe, a test harness — has nothing to contribute.
	Latency        *LatencyTracker
	DefaultTimeout time.Duration
}

// RequestContext identifies the caller and the model for one proxied request.
type RequestContext struct {
	DownstreamTokenID   int64
	DownstreamTokenName string
	ClientType          string
	RequestModel        *string
	ForwardModel        *string
	Method              string
	Path                string
	LogBodyMaxBytes     int
	// RequestUID is shared by every attempt this downstream request makes, so
	// the rows they each write can be recognised as one request's chain. Empty
	// leaves the column NULL, which is what a caller that does not track
	// attempts should do rather than inventing a value.
	RequestUID string
	// AttemptIndex is 0 for the first upstream attempt.
	AttemptIndex int32
	// ReceivedAt is when the gateway accepted the downstream request, which is
	// the origin PreUpstreamMs is measured from. A zero value leaves that column
	// NULL: an unset origin cannot be distinguished from one at the epoch, and a
	// pre-upstream figure of several decades would be read as real.
	ReceivedAt time.Time
	// FailoverEligible tells this attempt that another one could follow it, which
	// is what licenses the first-event gate to hold a 2xx SSE response back until
	// the stream proves itself.
	//
	// The caller decides, because only the caller knows whether the attempt budget
	// is spent or another channel is routable. With it false the stream is handed
	// over the moment its headers arrive, exactly as before the gate existed:
	// there is no point paying for a decision nobody can act on.
	FailoverEligible bool
}

// ProxyRequest forwards a request upstream, streaming SSE bodies as they arrive.
func ProxyRequest(ctx context.Context, deps Deps, policy AutoWeightPolicy,
	upstream *models.UpstreamRow, requestCtx RequestContext,
	prepared *PreparedRequest) (*Response, error) {
	start := time.Now()
	autoWeightEnabled := upstream.AutoWeightEnabled == 1

	timeout := deps.DefaultTimeout
	if upstream.TimeoutSeconds > 0 {
		timeout = time.Duration(upstream.TimeoutSeconds * float64(time.Second))
	}
	attemptCtx, cancel := context.WithCancel(ctx)
	attempt := newAttemptTimeout(cancel, timeout)

	request, err := buildUpstreamRequest(attemptCtx, requestCtx.Method, prepared)
	if err != nil {
		attempt.stop()

		// The channel's own configuration is what fails here — a base URL the
		// request builder will not accept. Charging it is what eventually takes
		// it out of routing; without that it keeps full weight and is chosen
		// again for every request it is going to fail in the same way.
		deps.AutoWeight.RecordFailure(upstream.ID, autoWeightEnabled, policy)

		// Logged here because the caller disarms its own fallback entry on any
		// error, trusting that the attempt logged itself. This was the one path
		// that did not, so the request left no trace at all.
		message := err.Error()
		statusCode := int32(502)
		entry := baseLogEntry(requestCtx, upstream, prepared, start)
		entry.StatusCode = &statusCode
		entry.DurationMs = elapsedMs(start)
		entry.Error = &message
		entry.SetFailure(FailureStageRequestBuild, statusCode)
		deps.LogWriter.Schedule(entry)

		// Returned unwrapped: buildUpstreamRequest already answers with an
		// upstream error, and wrapping it again repeated the prefix in both the
		// response and the log.
		return nil, err
	}

	response, err := deps.HTTPClient.Do(request)

	// Do returning is the moment the upstream response headers are available, so
	// this is where that sample point is taken. On the failure path it is left
	// unset: no headers arrived, and a figure here would say they did.
	headersMs := elapsedMs(start)

	if err != nil {
		attempt.stop()

		// A client that walks away cancels this request, and the failure that
		// surfaces here looks like any other. It is not the channel's doing, so
		// it is reported as a client abort and left out of the health score.
		clientGone := !attempt.Expired() && ctx.Err() != nil

		statusCode := int32(502)
		stage := FailureStageConnect
		switch {
		case clientGone:
			statusCode = 499
			stage = FailureStageClientCancelled
		case attempt.Expired():
			// The attempt's own clock ran out: a gateway timeout.
			statusCode = 504
		}
		if !clientGone {
			deps.AutoWeight.RecordFailure(upstream.ID, autoWeightEnabled, policy)
		}

		message := err.Error()
		entry := baseLogEntry(requestCtx, upstream, prepared, start)
		entry.StatusCode = &statusCode
		entry.DurationMs = elapsedMs(start)
		entry.Error = &message
		entry.SetFailure(stage, statusCode)
		deps.LogWriter.Schedule(entry)

		return nil, apperr.Upstream(message)
	}

	responseHeaders := flattenHeaders(response.Header)
	contentType := responseHeaders["content-type"]
	status := response.StatusCode

	if status >= 200 && status < 300 && IsSSEContentType(contentType) {
		entry := baseLogEntry(requestCtx, upstream, prepared, start)
		entry.Stream = true
		entry.UpstreamHeadersMs = headersMs
		statusCode := int32(status)
		entry.StatusCode = &statusCode

		var lead *sseLead
		if requestCtx.FailoverEligible {
			// A 2xx header is the channel accepting the request, not answering it.
			// Returning here on the strength of that header is what let a channel
			// that accepts everything and streams nothing swallow requests: the
			// retry loop saw a 2xx and stopped, and the client waited out the
			// timeout on a stream that was never going to speak.
			//
			// So the response is held until one complete event proves the channel
			// is answering. Nothing has reached the client yet, which is the only
			// window in which switching channels is invisible to them.
			var gateErr error
			lead, gateErr = awaitFirstSSEEvent(response.Body,
				func() int32 { return int32(time.Since(start).Milliseconds()) },
				requestCtx.LogBodyMaxBytes)
			if gateErr != nil {
				response.Body.Close()
				attempt.stop()
				return nil, logFirstEventFailure(ctx, deps, policy, upstream,
					autoWeightEnabled, attempt, entry, start, gateErr)
			}
		}

		stream := newSSEStream(ctx, response.Body, attempt, start, status, responseHeaders,
			requestCtx.LogBodyMaxBytes, entry, deps, policy, autoWeightEnabled, upstream.ID,
			lead)
		return &Response{Status: status, Headers: responseHeaders, Body: stream}, nil
	}

	bodyBytes, streamedFirstTokenMs, err := readResponseBody(response.Body, start, attempt.extend)
	response.Body.Close()
	attempt.stop()
	if err != nil {
		clientGone := !attempt.Expired() && ctx.Err() != nil

		statusCode := int32(502)
		stage := FailureStageResponseBody
		switch {
		case clientGone:
			statusCode = 499
			stage = FailureStageClientCancelled
		case attempt.Expired():
			statusCode = 504
		}
		if !clientGone {
			deps.AutoWeight.RecordFailure(upstream.ID, autoWeightEnabled, policy)
		}

		message := err.Error()
		entry := baseLogEntry(requestCtx, upstream, prepared, start)
		entry.StatusCode = &statusCode
		entry.SetFailure(stage, statusCode)
		// The headers did arrive; it was the body that failed. Recording them
		// here is what shows a channel that answers promptly and then stalls
		// mid-body, which is otherwise indistinguishable from one that never
		// answered at all.
		entry.UpstreamHeadersMs = headersMs
		entry.DurationMs = elapsedMs(start)
		entry.Error = &message
		deps.LogWriter.Schedule(entry)
		return nil, apperr.Upstream(message)
	}

	succeeded := status >= 200 && status < 300
	if succeeded {
		deps.AutoWeight.RecordSuccess(upstream.ID, autoWeightEnabled, policy)
		// Header arrival is the latency sample for a buffered answer: it is when
		// the channel started responding, which is independent of how long the
		// answer itself was. Total duration would rank a channel by the size of
		// the replies it happened to be asked for.
		deps.Latency.Record(upstream.ID, headersMs)
	} else {
		deps.AutoWeight.RecordFailure(upstream.ID, autoWeightEnabled, policy)
	}

	responseSnapshot := SnapshotResponse(status, responseHeaders, bodyBytes,
		requestCtx.LogBodyMaxBytes)
	usage := ExtractUsage(bodyBytes, contentType)
	isStream := bytes.HasPrefix(bodyBytes, []byte("data:")) ||
		strings.Contains(contentType, "event-stream")

	// A true streamed time-to-first-token is preferred; buffered detection is
	// only a fallback, and only for stream bodies.
	var firstTokenMs *int32
	if isStream {
		firstTokenMs = streamedFirstTokenMs
		if firstTokenMs == nil && HasVisibleToken(bodyBytes) {
			firstTokenMs = elapsedMs(start)
		}
	}

	entry := baseLogEntry(requestCtx, upstream, prepared, start)
	statusCode := int32(status)
	entry.StatusCode = &statusCode
	entry.UpstreamHeadersMs = headersMs
	entry.Stream = isStream
	entry.ResponseReasoningEffort = ExtractResponseReasoningEffort(bodyBytes, contentType)
	entry.PromptTokens = usage.PromptTokens
	entry.CompletionTokens = usage.CompletionTokens
	entry.TotalTokens = usage.TotalTokens
	entry.PromptCachedTokens = usage.PromptCachedTokens
	entry.CacheCreationTokens = usage.CacheCreationTokens
	entry.CompletionReasoningTokens = usage.CompletionReasoningTokens
	entry.FirstTokenMs = firstTokenMs
	entry.DurationMs = elapsedMs(start)
	if !succeeded {
		// The channel answered, and what it answered is a refusal. The stage says
		// the status is the whole story, which is what separates it from a channel
		// that could not be reached at all — both of which used to read as 502-ish
		// failures with nothing to tell them apart.
		entry.SetFailure(FailureStageUpstreamStatus, statusCode)
	}
	entry.UpstreamResponse = responseSnapshot
	entry.DownstreamResponse = responseSnapshot

	// Scheduled when the body is closed rather than here. Here is before the
	// response has reached the client at all, so a client that leaves during
	// delivery would be recorded as having received what the upstream sent.
	return &Response{
		Status:  status,
		Headers: responseHeaders,
		Body:    newBufferedStream(ctx, bodyBytes, entry, deps, statusCode),
	}, nil
}

// logFirstEventFailure records a 2xx SSE stream that never produced an event and
// returns the error the caller reports.
//
// The status it writes is the one that describes who ended it, not the 2xx the
// upstream sent: a row saying 200 for a stream that delivered nothing is how the
// console came to show these as successes. The upstream's own status stays in the
// response snapshot.
func logFirstEventFailure(ctx context.Context, deps Deps, policy AutoWeightPolicy,
	upstream *models.UpstreamRow, autoWeightEnabled bool, attempt *attemptTimeout,
	entry LogEntry, start time.Time, cause error) error {
	clientGone := !attempt.Expired() && ctx.Err() != nil

	statusCode := int32(502)
	stage := FailureStageFirstEvent
	switch {
	case clientGone:
		statusCode = 499
		stage = FailureStageClientCancelled
	case attempt.Expired():
		// The channel accepted the request and then went quiet past its own
		// timeout, which is a gateway timeout however encouraging its header was.
		statusCode = 504
	}
	if !clientGone {
		deps.AutoWeight.RecordFailure(upstream.ID, autoWeightEnabled, policy)
		deps.Metrics.RecordSSEUpstreamError()
	}

	message := cause.Error()
	entry.StatusCode = &statusCode
	entry.DurationMs = elapsedMs(start)
	entry.Error = &message
	entry.SetFailure(stage, statusCode)
	deps.LogWriter.Schedule(entry)

	return apperr.Upstream(message)
}

func buildUpstreamRequest(ctx context.Context, method string, prepared *PreparedRequest) (*http.Request, error) {
	var body io.Reader
	if len(prepared.UpstreamBody) > 0 {
		body = bytes.NewReader(prepared.UpstreamBody)
	}

	request, err := http.NewRequestWithContext(ctx, method, prepared.URL, body)
	if err != nil {
		return nil, apperr.Upstream(err.Error())
	}
	for name, value := range prepared.ForwardHeaders {
		if containsFold(HopByHopHeaders, name) {
			continue
		}
		request.Header.Set(name, value)
	}
	return request, nil
}

// baseLogEntry fills the fields every attempt reports, regardless of outcome.
//
// start is this attempt's timing origin, which is also what pre_upstream_ms is
// measured against: the interval it reports ends here, so it can be filled for
// every outcome including the ones that never reach the upstream.
func baseLogEntry(requestCtx RequestContext, upstream *models.UpstreamRow,
	prepared *PreparedRequest, start time.Time) LogEntry {
	upstreamID := upstream.ID
	upstreamName := upstream.Name
	tokenID := requestCtx.DownstreamTokenID
	tokenName := requestCtx.DownstreamTokenName
	clientType := requestCtx.ClientType
	attemptIndex := requestCtx.AttemptIndex

	entry := LogEntry{
		Method:              requestCtx.Method,
		Path:                requestCtx.Path,
		DownstreamTokenID:   &tokenID,
		DownstreamTokenName: &tokenName,
		ClientType:          &clientType,
		UpstreamID:          &upstreamID,
		UpstreamName:        &upstreamName,
		Model:               requestCtx.ForwardModel,
		RequestModel:        requestCtx.RequestModel,
		UpstreamModel:       requestCtx.ForwardModel,
		ReasoningEffort:     prepared.ReasoningEffort,
		DownstreamRequest:   prepared.DownstreamSnapshot,
		UpstreamRequest:     prepared.UpstreamSnapshot,
		AttemptIndex:        &attemptIndex,
		PreUpstreamMs:       preUpstreamMs(requestCtx.ReceivedAt, start),
	}
	if requestCtx.RequestUID != "" {
		uid := requestCtx.RequestUID
		entry.RequestUID = &uid
	}
	return entry
}

// preUpstreamMs measures the gateway's own latency ahead of one attempt.
//
// A zero receivedAt means the caller does not sample it, which leaves the column
// NULL. A negative interval is clamped to zero rather than stored: the two
// instants come from the same clock, so the only way to get one is a caller that
// passed an origin from after the attempt began, and a negative duration in the
// waterfall would be read as a bug in the display instead of in the sample.
func preUpstreamMs(receivedAt, start time.Time) *int32 {
	if receivedAt.IsZero() {
		return nil
	}
	measured := int32(start.Sub(receivedAt).Milliseconds())
	if measured < 0 {
		measured = 0
	}
	return &measured
}

func elapsedMs(start time.Time) *int32 {
	measured := int32(time.Since(start).Milliseconds())
	return &measured
}

func flattenHeaders(headers http.Header) map[string]string {
	flattened := make(map[string]string, len(headers))
	for name, values := range headers {
		if len(values) > 0 {
			flattened[strings.ToLower(name)] = values[0]
		}
	}
	return flattened
}

// MaxUpstreamResponseBytes caps a buffered upstream response.
//
// The downstream request body is already bounded, but the response was not: a
// misbehaving or compromised channel could return a body large enough to exhaust
// the gateway's memory, and a handful of concurrent ones could do it outright.
// The limit is far above any real completion, so it only ever catches a channel
// that is not answering in good faith.
const MaxUpstreamResponseBytes = 128 << 20

// ErrUpstreamResponseTooLarge reports a buffered response that ran past the cap.
var ErrUpstreamResponseTooLarge = errors.New("upstream response exceeded the maximum buffered size")

// readResponseBody reads a full upstream body while recording the true
// time-to-first-token for SSE streams.
//
// progress is called for each chunk, so the attempt's clock measures silence
// from the upstream rather than the total time a long body takes to arrive.
func readResponseBody(body io.Reader, start time.Time, progress func()) ([]byte, *int32, error) {
	var collected bytes.Buffer
	observation := &sseObservation{}
	measure := func() int32 { return int32(time.Since(start).Milliseconds()) }

	buffer := make([]byte, 32*1024)
	for {
		read, err := body.Read(buffer)
		if read > 0 {
			if collected.Len()+read > MaxUpstreamResponseBytes {
				return nil, nil, ErrUpstreamResponseTooLarge
			}
			progress()
			chunk := buffer[:read]
			collected.Write(chunk)
			observation.observeChunk(chunk, measure)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, err
		}
	}

	// The final partial line is observed too, keeping parity with buffered
	// detection.
	observation.finish(measure)
	return collected.Bytes(), observation.firstTokenMs, nil
}
