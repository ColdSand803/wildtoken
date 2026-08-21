// Package handlers implements the HTTP endpoints WildToken serves.
package handlers

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/middleware"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/proxy"
)

// maxDownstreamBodyBytes bounds a downstream request body, so one caller cannot
// exhaust memory with an unbounded upload.
const maxDownstreamBodyBytes = 50 * 1024 * 1024

// hopByHopResponseHeaders must not be copied back to the downstream client.
var hopByHopResponseHeaders = []string{
	"connection",
	"keep-alive",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"proxy-authenticate",
	"proxy-authorization",
	"content-encoding",
	"content-length",
}

func parseModelFromBody(body []byte) *string {
	var request map[string]any
	if err := json.Unmarshal(body, &request); err != nil {
		return nil
	}
	model, ok := request["model"].(string)
	if !ok || model == "" {
		return nil
	}
	return &model
}

// upstreamSelector reads an explicit channel hint from the header or query.
func upstreamSelector(r *http.Request) *string {
	if value := strings.TrimSpace(r.Header.Get("x-wildtoken-upstream")); value != "" {
		return &value
	}
	if value := r.URL.Query().Get("upstream"); value != "" {
		return &value
	}
	return nil
}

// writeProtocolError renders an error in the shape the caller's protocol expects.
func writeProtocolError(w http.ResponseWriter, status int, path, message, errorType string) {
	if models.IsAnthropicMessages(models.ProxyPath(path)) {
		apperr.WriteJSON(w, status, map[string]any{
			"type":  "error",
			"error": map[string]string{"type": errorType, "message": message},
		})
		return
	}
	apperr.WriteJSON(w, status, map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    errorType,
			"code":    nil,
		},
	})
}

// ModelNotAllowedCode identifies a model refused by the token's whitelist at the
// top level of the refusal, mirroring the other downstream rejections: a caller
// that does not speak either vendor's error shape can branch on it.
const ModelNotAllowedCode = "MODEL_NOT_ALLOWED"

// ModelNotAllowedMessage is the operator-facing summary carried alongside the code.
const ModelNotAllowedMessage = "该 API key 不允许调用此模型"

// modelPermittedByToken judges a request against the token's whitelist.
//
// A restricted token is refused when the body named no model at all. That is the
// strict direction, and it is chosen deliberately: the alternative admits any
// request whose model the gateway could not read, which turns a malformed or
// unrecognised body into a way past the whitelist. An unrestricted token is
// unaffected, so this only ever applies to a credential an operator has narrowed
// on purpose.
func modelPermittedByToken(policy models.AllowedModelsPolicy, model *string) bool {
	if policy.Unrestricted() {
		return true
	}
	if model == nil {
		return false
	}
	return policy.Permits(*model)
}

// modelNotAllowedDetail explains the refusal, naming the permitted list.
//
// The list is disclosed because the caller holds the credential it describes:
// they can already discover it by trying models, and telling them saves a support
// round trip. It is not disclosed for a request that named no model, where there
// is nothing to compare it against and the useful correction is different.
func modelNotAllowedDetail(model *string, policy models.AllowedModelsPolicy) string {
	patterns := strings.Join(policy.Patterns(), ", ")
	if model == nil || strings.TrimSpace(*model) == "" {
		return "this API key is restricted to specific models, so the request must name one; " +
			"allowed: " + patterns
	}
	return "model " + *model + " is not allowed for this API key; allowed: " + patterns
}

// writeModelNotAllowedRejection refuses a model the token may not call.
//
// 403 rather than 400: the request is well formed and the model may well exist —
// this credential is not permitted to use it. Both vendor dialects have a
// permission error shape, and an SDK reading either will not retry it, which is
// the correct behaviour for a refusal that will not change on its own.
func writeModelNotAllowedRejection(w http.ResponseWriter, anthropic bool, detail string) {
	body := map[string]any{
		"code":    ModelNotAllowedCode,
		"message": ModelNotAllowedMessage,
	}
	if anthropic {
		body["type"] = "error"
		body["error"] = map[string]string{"type": "permission_error", "message": detail}
	} else {
		body["error"] = map[string]string{
			"message": detail,
			"type":    "invalid_request_error",
			"code":    "model_not_allowed",
		}
	}
	apperr.WriteJSON(w, http.StatusForbidden, body)
}

// UpstreamRateLimitedCode identifies "every routable channel is rate-limited"
// at the top level of the refusal, mirroring the API-key rejections in
// middleware: a caller that does not speak either vendor's error shape can
// branch on it.
const UpstreamRateLimitedCode = "UPSTREAM_RATE_LIMITED"

// UpstreamRateLimitedMessage is the operator-facing summary carried alongside
// the code.
const UpstreamRateLimitedMessage = "渠道请求频率超限"

// writeUpstreamRateLimitRejection reports that routing found candidates, but
// every one of them is currently rate-limited.
//
// The refusal heals itself once a window slides, so both vendor dialects use
// their rate-limit shape, which is what SDK retry logic keys on. The body
// carries the refusal twice for the same reason the token-side rejections do: a
// vendor SDK only looks inside `error`, while a caller written against this
// proxy reads the top-level code.
func writeUpstreamRateLimitRejection(w http.ResponseWriter, path string) {
	detail := "所有可路由渠道均已达到限速，请稍后重试"
	body := map[string]any{
		"code":    UpstreamRateLimitedCode,
		"message": UpstreamRateLimitedMessage,
	}
	if models.IsAnthropicMessages(models.ProxyPath(path)) {
		body["type"] = "error"
		body["error"] = map[string]string{"type": "rate_limit_error", "message": detail}
	} else {
		body["error"] = map[string]string{
			"message": detail,
			"type":    "rate_limit_exceeded",
			"code":    "rate_limit_exceeded",
		}
	}
	apperr.WriteJSON(w, http.StatusTooManyRequests, body)
}

// noRouteReason describes why routing found no upstream.
//
// The text goes to both the downstream error body and the request log, so a 503
// can be traced back to the requested model and channel hint without
// reproducing the request.
// noRouteReason names the group as well, because with group isolation the same
// model can be routable for one token and not for another; without it a 503
// would be indistinguishable from a misconfigured channel.
func noRouteReason(selector, model *string, groupName string) string {
	target := "a request without a model"
	if model != nil {
		target = "model " + strconv.Quote(*model)
	}
	scope := " in group " + strconv.Quote(groupName)
	if selector != nil {
		return "no enabled upstream matches " + target + scope +
			" on the requested channel " + strconv.Quote(*selector)
	}
	return "no enabled upstream matches " + target + scope
}

// abortLogGuard records a request that ended before the proxy could log it.
//
// Rust armed this through Drop. Go has no destructor, so every exit path calls
// either Disarm or one of the logging methods; the handler defers Finish as the
// backstop for a panic or an early return that forgets.
type abortLogGuard struct {
	logWriter *proxy.LogWriter
	// startedAt is when the gateway accepted this request. It is both this
	// guard's own duration origin and the origin every attempt's pre_upstream_ms
	// is measured from, so the two figures cannot disagree about when the
	// request began.
	startedAt time.Time
	// requestUID is minted here because this is the first thing built per
	// request, so every row the request produces — including the abort fallback —
	// can carry it.
	requestUID string
	entry      *proxy.LogEntry
}

func newAbortLogGuard(logWriter *proxy.LogWriter, method, path string) *abortLogGuard {
	status := int32(499)
	message := "client disconnected before proxy completed"
	requestUID := newRequestUID()
	return &abortLogGuard{
		logWriter:  logWriter,
		startedAt:  time.Now(),
		requestUID: requestUID,
		entry: &proxy.LogEntry{
			Method:     method,
			Path:       path,
			StatusCode: &status,
			Error:      &message,
			// The uid is set even on this fallback row, so a request that failed
			// before reaching an upstream is still identifiable as one request.
			// AttemptIndex stays nil: no attempt was made, which is not the same
			// as attempt 0.
			RequestUID: &requestUID,
		},
	}
}

// requestUIDBytes is 8 random bytes: enough that two concurrent requests
// colliding is not a practical concern, while keeping the column short since it
// is written on every log row.
const requestUIDBytes = 8

// newRequestUID mints the key that ties one request's attempt rows together.
//
// A failure to read the system's randomness leaves the uid empty rather than
// failing the request. The value is only a correlation key for the console: a
// proxied request must not be refused because grouping its log rows was not
// possible.
func newRequestUID() string {
	buffer := make([]byte, requestUIDBytes)
	if _, err := rand.Read(buffer); err != nil {
		return ""
	}
	return hex.EncodeToString(buffer)
}

func (g *abortLogGuard) setModel(model *string) {
	if g.entry == nil {
		return
	}
	g.entry.Model = model
	g.entry.RequestModel = model
}

func (g *abortLogGuard) setDownstreamToken(tokenID int64, tokenName string) {
	if g.entry == nil {
		return
	}
	g.entry.DownstreamTokenID = &tokenID
	g.entry.DownstreamTokenName = &tokenName
}

// setQuotaPeriod records the reset cycle the request was admitted under, so a row
// this guard writes settles against that cycle rather than the current one.
func (g *abortLogGuard) setQuotaPeriod(stamp string) {
	if g.entry == nil {
		return
	}
	g.entry.QuotaPeriodStamp = stamp
}

func (g *abortLogGuard) setClientType(clientType string) {
	if g.entry == nil {
		return
	}
	g.entry.ClientType = &clientType
}

func (g *abortLogGuard) setUpstream(upstreamID int64, upstreamName string, forwardModel *string) {
	if g.entry == nil {
		return
	}
	g.entry.UpstreamID = &upstreamID
	g.entry.UpstreamName = &upstreamName
	g.entry.UpstreamModel = forwardModel
	if forwardModel != nil {
		g.entry.Model = forwardModel
	}
}

func (g *abortLogGuard) setRequestSnapshots(downstream, upstream json.RawMessage) {
	if g.entry == nil {
		return
	}
	g.entry.DownstreamRequest = downstream
	g.entry.UpstreamRequest = upstream
}

// disarm gives up ownership of the log, because the proxy already wrote one.
func (g *abortLogGuard) disarm() { g.entry = nil }

// logAndDisarm records a specific failure instead of the default abort.
func (g *abortLogGuard) logAndDisarm(statusCode int32, message string, stage proxy.FailureStage) {
	entry := g.entry
	g.entry = nil
	if entry == nil {
		return
	}
	entry.StatusCode = &statusCode
	entry.Error = &message
	entry.DurationMs = g.elapsed()
	entry.SetFailure(stage, statusCode)
	g.logWriter.Schedule(*entry)
}

// finish writes the default abort log if no other path claimed it.
func (g *abortLogGuard) finish() {
	entry := g.entry
	g.entry = nil
	if entry == nil {
		return
	}
	entry.DurationMs = g.elapsed()
	// The default entry is a 499: this guard only fires for a request that ended
	// before anything else could describe it.
	entry.SetFailure(proxy.FailureStageClientCancelled, 499)
	g.logWriter.Schedule(*entry)
}

func (g *abortLogGuard) elapsed() *int32 {
	measured := int32(time.Since(g.startedAt).Milliseconds())
	return &measured
}

// ProxyHandler forwards OpenAI-compatible requests to upstream providers.
func ProxyHandler(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := middleware.DownstreamAuthFrom(r.Context())
		if !ok {
			writeProtocolError(w, http.StatusUnauthorized, r.URL.Path,
				"Incorrect API key provided", "invalid_api_key")
			return
		}

		// The path after /v1/, for example "chat/completions".
		path := models.ProxyPath(r.URL.Path)

		guard := newAbortLogGuard(state.LogWriter, r.Method, path)
		defer guard.finish()
		guard.setDownstreamToken(auth.TokenID, auth.TokenName)
		guard.setClientType(auth.ClientType)
		guard.setQuotaPeriod(auth.QuotaPeriodStamp)

		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxDownstreamBodyBytes))
		if err != nil {
			// A body that exceeded the cap is the caller's error; anything else
			// means the caller went away mid-upload.
			var maxBytesError *http.MaxBytesError
			if errors.As(err, &maxBytesError) {
				guard.logAndDisarm(400, "failed to read downstream request body: "+err.Error(),
					proxy.FailureStageGateway)
				apperr.BadRequest("failed to read body: " + err.Error()).Write(w)
				return
			}
			guard.logAndDisarm(499,
				"client disconnected while reading downstream request body: "+err.Error(),
				proxy.FailureStageClientCancelled)
			apperr.BadRequest("failed to read body: " + err.Error()).Write(w)
			return
		}

		model := parseModelFromBody(body)
		guard.setModel(model)

		// The whitelist is judged on the model the client asked for, before any
		// channel mapping rewrites it. A channel that maps gpt-4o onto some other
		// provider's id must not be able to launder a model past this check, and
		// the operator wrote the list in terms of what their callers send.
		if !modelPermittedByToken(auth.AllowedModels, model) {
			detail := modelNotAllowedDetail(model, auth.AllowedModels)
			guard.logAndDisarm(http.StatusForbidden, detail, proxy.FailureStageGateway)
			writeModelNotAllowedRejection(w, models.IsAnthropicMessages(path), detail)
			return
		}

		selector := upstreamSelector(r)

		runtimeSettings := state.Runtime.Get()
		policy := proxy.NewAutoWeightPolicy(&runtimeSettings)

		// A direct selection is resolved once; the retry loop reuses it rather
		// than re-running a selector that can only ever pick the same channel.
		selectionPolicy := state.SelectionPolicy()

		var directSelection *proxy.Selection
		if selector != nil {
			directSelection, err = proxy.SelectUpstream(r.Context(), state.DB, state.Routing,
				state.AutoWeight, policy, selectionPolicy, selector, model, auth.GroupID, nil)
			if err != nil {
				guard.logAndDisarm(500, "upstream selection failed: "+err.Error(),
					proxy.FailureStageGateway)
				apperr.WriteError(w, err)
				return
			}
		}

		response, err := runProxyAttempts(w, r, state, proxyAttemptConfig{
			guard:           guard,
			auth:            auth,
			groupName:       resolveGroupName(r.Context(), state, auth.GroupID),
			path:            path,
			body:            body,
			model:           model,
			selector:        selector,
			directSelection: directSelection,
			policy:          policy,
			selectionPolicy: selectionPolicy,
			runtimeSettings: runtimeSettings,
		})
		if err != nil {
			// Every failing path inside runProxyAttempts logs the attempt it
			// failed on, with the status that describes it. Leaving the guard
			// armed added a second row for the same request, blaming a client
			// disconnect for what was an upstream failure and leaving the
			// console unable to tell the two apart.
			guard.disarm()
			apperr.WriteError(w, err)
			return
		}
		if response == nil {
			// Routing found nothing; the reason was already written and logged.
			return
		}
		guard.disarm()

		writeProxiedResponse(w, response)
	}
}

type proxyAttemptConfig struct {
	guard *abortLogGuard
	auth  middleware.DownstreamAuth
	// groupName is resolved once for the error message, so the retry loop does
	// not query it per attempt.
	groupName       string
	path            string
	body            []byte
	model           *string
	selector        *string
	directSelection *proxy.Selection
	policy          proxy.AutoWeightPolicy
	selectionPolicy proxy.SelectionPolicy
	runtimeSettings models.RuntimeSettings
}

// runProxyAttempts forwards the request, retrying a failure up to the
// configured limit. A nil response with a nil error means routing produced no
// attempt and the refusal has already been written and logged: a 429 when every
// candidate was rate limited, a 503 when there was no route at all.
func runProxyAttempts(w http.ResponseWriter, r *http.Request, state *appstate.State,
	config proxyAttemptConfig) (*proxy.Response, error) {
	maxRetries := int(config.runtimeSettings.MaxRetries)
	logBodyMaxBytes := int(config.runtimeSettings.LogBodyMaxBytes)

	var previousUpstreamID *int64
	var lastFailure *attemptResult

	// rateLimited collects the channels whose rate limit refused this request.
	// A refused channel stays out of routing for the rest of the request, so
	// re-selection falls over to the remaining candidates instead of drawing the
	// same channel again. Nil until the first refusal.
	var rateLimited map[int64]bool
	// failedUpstreams collects the channels that already failed this request.
	// They are preferred against rather than banned: routing tries to find one
	// that has not failed yet, and only if there is none does it come back to a
	// channel that has. A hard ban would break the single-channel case the retry
	// interval exists for, where trying the same channel again after a pause is
	// the whole point.
	var failedUpstreams map[int64]bool

	for attempt := 0; ; attempt++ {
		// Selection repeats until a channel's rate limit admits the request;
		// admission records the request, refusal excludes the channel. The loop
		// terminates because every refusal shrinks the candidate set.
		var selected *proxy.Selection
		for {
			selected = config.directSelection
			if config.selector == nil {
				var err error
				selected, err = selectWithFailover(r, state, config, rateLimited, failedUpstreams)
				if err != nil {
					config.guard.logAndDisarm(500, "upstream selection failed: "+err.Error(),
						proxy.FailureStageGateway)
					return nil, err
				}
			} else if selected != nil && rateLimited[selected.Upstream.ID] {
				// A direct selector has no other candidate behind it.
				selected = nil
			}
			if selected == nil ||
				proxy.UpstreamRateLimitAdmits(state.UpstreamRateLimiter, &selected.Upstream) {
				break
			}
			if rateLimited == nil {
				rateLimited = map[int64]bool{}
			}
			rateLimited[selected.Upstream.ID] = true
		}

		if selected == nil {
			// Nothing else to try. A buffered failure is the caller's answer.
			if lastFailure != nil {
				return lastFailure.response, lastFailure.err
			}
			if len(rateLimited) > 0 {
				// Routing had candidates, but every one of them refused: the
				// request is only deferred, not unroutable, so the answer is a
				// 429 rather than the no-route 503.
				config.guard.logAndDisarm(429, "all candidate channels are rate limited",
					proxy.FailureStageRateLimited)
				writeUpstreamRateLimitRejection(w, config.path)
				return nil, nil
			}
			reason := noRouteReason(config.selector, config.model, config.groupName)
			config.guard.logAndDisarm(503, reason, proxy.FailureStageNoRoute)
			writeProtocolError(w, http.StatusServiceUnavailable,
				config.path, reason, "upstream_not_configured")
			return nil, nil
		}

		// Retrying the same channel immediately would usually hit the same
		// condition, so the configured pause applies first.
		if attempt > 0 && previousUpstreamID != nil &&
			*previousUpstreamID == selected.Upstream.ID &&
			config.runtimeSettings.SameUpstreamRetryIntervalMs > 0 {
			select {
			case <-r.Context().Done():
				// Logged here because no attempt was made to log it: this is
				// the one error path out of this function that ProxyRequest
				// never saw.
				config.guard.logAndDisarm(499, "client disconnected during retry backoff",
					proxy.FailureStageClientCancelled)
				return nil, apperr.Upstream("client disconnected during retry backoff")
			case <-time.After(time.Duration(config.runtimeSettings.SameUpstreamRetryIntervalMs) *
				time.Millisecond):
			}
		}

		// Once a new attempt has a route, the previous buffered failure is no
		// longer needed. Its log was already scheduled by ProxyRequest.
		lastFailure = nil

		config.guard.setUpstream(selected.Upstream.ID, selected.Upstream.Name, selected.ForwardModel)

		prepared, err := proxy.PrepareRequest(r.Header, &selected.Upstream, r.Method,
			config.path, r.URL.RawQuery, selected.ForwardModel, config.body, logBodyMaxBytes)
		if err != nil {
			// The channel's stored header configuration is what fails here, so
			// the channel is charged for it. A channel that cannot build a
			// request fails every one it is given, and without a penalty it
			// keeps full weight and keeps being chosen to fail again.
			state.AutoWeight.RecordFailure(selected.Upstream.ID,
				selected.Upstream.AutoWeightEnabled == 1, config.policy)
			config.guard.logAndDisarm(502, err.Error(), proxy.FailureStageRequestBuild)
			return nil, err
		}
		config.guard.setRequestSnapshots(prepared.DownstreamSnapshot, prepared.UpstreamSnapshot)

		// Whether another attempt could follow is decided before this one runs,
		// because the streaming path needs to know: holding a 2xx SSE response
		// back to see whether it produces an event is only worth its latency when
		// there is somewhere else to go.
		response, err := proxy.ProxyRequest(r.Context(), state.ProxyDeps(), config.policy,
			&selected.Upstream, proxy.RequestContext{
				DownstreamTokenID:   config.auth.TokenID,
				DownstreamTokenName: config.auth.TokenName,
				QuotaPeriodStamp:    config.auth.QuotaPeriodStamp,
				ClientType:          config.auth.ClientType,
				RequestModel:        config.model,
				ForwardModel:        selected.ForwardModel,
				Method:              r.Method,
				Path:                config.path,
				LogBodyMaxBytes:     logBodyMaxBytes,
				RequestUID:          config.guard.requestUID,
				AttemptIndex:        int32(attempt),
				ReceivedAt:          config.guard.startedAt,
				FailoverEligible:    attempt < maxRetries,
			}, prepared)

		if !shouldFailover(r, response, err) || attempt >= maxRetries {
			return response, err
		}

		// A failed attempt's body is buffered rather than discarded. Its
		// connection is released either way, but if no channel is left to try
		// this response is what the caller receives: draining it delivered the
		// upstream's status and headers with an empty body, throwing away the
		// only explanation of what went wrong.
		if response != nil {
			response.Body = bufferFailedBody(response.Body)
		}

		upstreamID := selected.Upstream.ID
		previousUpstreamID = &upstreamID
		if failedUpstreams == nil {
			failedUpstreams = map[int64]bool{}
		}
		failedUpstreams[upstreamID] = true
		lastFailure = &attemptResult{response: response, err: err}
	}
}

// selectWithFailover routes an attempt, preferring a channel that has not
// already failed this request.
//
// Two passes rather than one exclusion set: the first asks for a channel that is
// neither rate-limited nor already failed, and only when there is none does the
// second allow a channel that failed to be tried again. Banning failed channels
// outright would turn a single-channel deployment's retry into an immediate
// no-route, and preferring nothing would keep drawing the broken channel while a
// healthy one sat unused — routing draws by weight, and one failure barely moves
// a weight.
func selectWithFailover(r *http.Request, state *appstate.State, config proxyAttemptConfig,
	rateLimited, failedUpstreams map[int64]bool) (*proxy.Selection, error) {
	if len(failedUpstreams) > 0 {
		exclude := make(map[int64]bool, len(rateLimited)+len(failedUpstreams))
		for id := range rateLimited {
			exclude[id] = true
		}
		for id := range failedUpstreams {
			exclude[id] = true
		}
		selected, err := proxy.SelectUpstream(r.Context(), state.DB, state.Routing,
			state.AutoWeight, config.policy, config.selectionPolicy, nil, config.model,
			config.auth.GroupID, exclude)
		if err != nil || selected != nil {
			return selected, err
		}
	}
	return proxy.SelectUpstream(r.Context(), state.DB, state.Routing,
		state.AutoWeight, config.policy, config.selectionPolicy, nil, config.model,
		config.auth.GroupID, rateLimited)
}

// shouldFailover decides whether an attempt's outcome earns another channel.
//
// The proxy used to retry every non-2xx response. That made one wrong credential
// fan out across every channel serving the model — each answering 401, each
// charged for it, the caller waiting through the whole list for the same refusal
// — and it retried 3xx redirects, which are not failures at all.
//
// The order of these checks is the policy:
//
//  1. A client that has gone is owed nothing. Retrying spent another channel's
//     rate-limit allowance and wrote another log row for a request nobody was
//     waiting for.
//  2. A transport-level error is the channel's own, and switching is worth it.
//     ProxyRequest has already decided this is not a client abort; it returns an
//     error for a failed dial, a body that died, and a stream that never spoke.
//  3. A response's status decides the rest, by the matrix in
//     proxy.IsRetryableUpstreamStatus.
func shouldFailover(r *http.Request, response *proxy.Response, err error) bool {
	if r.Context().Err() != nil {
		return false
	}
	if err != nil {
		return true
	}
	if response == nil {
		return false
	}
	if response.Status >= 200 && response.Status < 300 {
		return false
	}
	return proxy.IsRetryableUpstreamStatus(response.Status)
}

type attemptResult struct {
	response *proxy.Response
	err      error
}

// maxBufferedFailureBytes caps what is kept from a failed attempt. A provider's
// error body is a small piece of JSON, so this only bounds a channel that is
// answering a rejection with something unreasonable.
const maxBufferedFailureBytes = 1 << 20

// bufferFailedBody reads a failed attempt's body into memory and closes the
// original, returning a reader over what it held.
//
// The body is normally already buffered by the time it gets here, but reading it
// again is what makes the release of the connection unconditional rather than a
// property of which path produced the response.
func bufferFailedBody(body io.ReadCloser) io.ReadCloser {
	defer body.Close()

	buffered, err := io.ReadAll(io.LimitReader(body, maxBufferedFailureBytes))
	if err != nil {
		// Whatever could not be read is not worth failing the retry over; the
		// status and headers still describe the attempt.
		buffered = nil
	}
	return io.NopCloser(bytes.NewReader(buffered))
}

// writeProxiedResponse copies an upstream response downstream, streaming it as
// it arrives so an SSE body is not buffered.
func writeProxiedResponse(w http.ResponseWriter, response *proxy.Response) {
	defer response.Body.Close()

	header := w.Header()
	for name, value := range response.Headers {
		if containsFold(hopByHopResponseHeaders, name) {
			continue
		}
		header.Set(name, value)
	}
	w.WriteHeader(response.Status)

	flusher, canFlush := w.(http.Flusher)
	buffer := make([]byte, 32*1024)
	for {
		read, err := response.Body.Read(buffer)
		if read > 0 {
			if _, writeErr := w.Write(buffer[:read]); writeErr != nil {
				return
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

// AggregateModelIDs collects unique model ids from enabled upstream configs,
// from their names and mapping keys.
func AggregateModelIDs(upstreams []models.UpstreamRow) []string {
	unique := map[string]bool{}

	for _, upstream := range upstreams {
		var names []string
		if err := json.Unmarshal([]byte(upstream.ModelNames), &names); err == nil {
			for _, name := range names {
				if trimmed := strings.TrimSpace(name); trimmed != "" {
					unique[trimmed] = true
				}
			}
		}

		var mappings map[string]json.RawMessage
		if err := json.Unmarshal([]byte(upstream.ModelMappings), &mappings); err == nil {
			for key := range mappings {
				if trimmed := strings.TrimSpace(key); trimmed != "" {
					unique[trimmed] = true
				}
			}
		}
		// model_prefixes are intentionally ignored: a prefix cannot expand into
		// concrete ids.
	}

	ids := make([]string, 0, len(unique))
	for id := range unique {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// OpenAIModelsListResponse renders ids in the OpenAI list shape.
func OpenAIModelsListResponse(ids []string) json.RawMessage {
	data := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		data = append(data, map[string]any{
			"id":       id,
			"object":   "model",
			"created":  0,
			"owned_by": "wildtoken",
		})
	}
	encoded, err := json.Marshal(map[string]any{"object": "list", "data": data})
	if err != nil {
		return json.RawMessage(`{"object":"list","data":[]}`)
	}
	return encoded
}

// resolveEnabledUpstreamForModels resolves a channel hint, refusing one the
// caller's group cannot reach so the filter cannot enumerate other groups.
func resolveEnabledUpstreamForModels(ctx context.Context, state *appstate.State,
	selector string, groupID int64) (models.UpstreamRow, error) {
	reachable := func(upstream models.UpstreamRow) (bool, error) {
		if upstream.Enabled != 1 {
			return false, nil
		}
		groupIDs, err := db.ListUpstreamGroupIDs(ctx, state.DB, upstream.ID)
		if err != nil {
			return false, err
		}
		for _, candidate := range groupIDs {
			if candidate == groupID {
				return true, nil
			}
		}
		return false, nil
	}

	if id, err := strconv.ParseInt(selector, 10, 64); err == nil {
		upstream, ok, err := db.GetUpstream(ctx, state.DB, id)
		if err != nil {
			return models.UpstreamRow{}, err
		}
		if ok {
			allowed, err := reachable(upstream)
			if err != nil {
				return models.UpstreamRow{}, err
			}
			if allowed {
				return upstream, nil
			}
		}
	}

	upstream, ok, err := db.GetUpstreamByName(ctx, state.DB, selector)
	if err != nil {
		return models.UpstreamRow{}, err
	}
	if ok {
		allowed, err := reachable(upstream)
		if err != nil {
			return models.UpstreamRow{}, err
		}
		if allowed {
			return upstream, nil
		}
	}

	// The message does not distinguish "does not exist" from "not in your
	// group", so the filter cannot be used to probe other groups.
	return models.UpstreamRow{}, apperr.NotFound("upstream not found or disabled: " + selector)
}

// ListModelsHandler serves GET /v1/models, aggregating the model list from the
// channels the caller's group can reach.
//
// An optional channel filter comes from X-WildToken-Upstream or ?upstream= (a
// name or an id). A filtered response skips the cache, and model_prefixes never
// expand into concrete ids.
func ListModelsHandler(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := middleware.DownstreamAuthFrom(r.Context())
		if !ok {
			writeProtocolError(w, http.StatusUnauthorized, r.URL.Path,
				"Incorrect API key provided", "invalid_api_key")
			return
		}

		if selector := upstreamSelector(r); selector != nil {
			upstream, err := resolveEnabledUpstreamForModels(r.Context(), state,
				*selector, auth.GroupID)
			if err != nil {
				apperr.WriteError(w, err)
				return
			}
			writeRawJSON(w, OpenAIModelsListResponse(
				permittedModelIDs(AggregateModelIDs([]models.UpstreamRow{upstream}),
					auth.AllowedModels)))
			return
		}

		// The key carries the token's policy fingerprint, so a restricted token
		// cannot read an entry computed for an unrestricted one — and editing a
		// whitelist moves the token to a different key rather than needing this
		// cache to be invalidated on token writes.
		cacheKey := appstate.ModelsCacheKey{
			GroupID:           auth.GroupID,
			PolicyFingerprint: auth.AllowedModels.Fingerprint(),
		}
		if cached := state.ModelsCache.Get(cacheKey); cached != nil {
			writeRawJSON(w, cached)
			return
		}

		upstreams, err := db.ListEnabledUpstreamsInGroup(r.Context(), state.DB, auth.GroupID)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		response := OpenAIModelsListResponse(
			permittedModelIDs(AggregateModelIDs(upstreams), auth.AllowedModels))

		// Another concurrent miss may have already filled the cache.
		if cached := state.ModelsCache.Get(cacheKey); cached != nil {
			writeRawJSON(w, cached)
			return
		}
		state.ModelsCache.Set(cacheKey, response)
		writeRawJSON(w, response)
	}
}

// permittedModelIDs narrows an aggregated model list to what a token may call.
//
// The intersection runs over concrete ids only, which is what AggregateModelIDs
// returns — model_prefixes never expand into ids, so a channel's prefix rule
// contributes nothing here either way. A whitelist entry naming a model no
// channel serves simply matches nothing; the list advertises what is both
// reachable and permitted, which is the same pair the proxy path enforces.
//
// The result is never nil, so an empty intersection serializes as an empty list
// rather than null: a token restricted to models its group cannot reach gets a
// well-formed empty list, which is the honest answer and keeps SDKs working.
func permittedModelIDs(ids []string, policy models.AllowedModelsPolicy) []string {
	if policy.Unrestricted() {
		return ids
	}
	permitted := make([]string, 0, len(ids))
	for _, id := range ids {
		if policy.Permits(id) {
			permitted = append(permitted, id)
		}
	}
	return permitted
}

func writeRawJSON(w http.ResponseWriter, body json.RawMessage) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(body)
}

func containsFold(list []string, name string) bool {
	for _, entry := range list {
		if strings.EqualFold(entry, name) {
			return true
		}
	}
	return false
}

// resolveGroupName reads a group's name for an error message, falling back to
// its id when the row is gone. Routing already decided; this only labels it.
func resolveGroupName(ctx context.Context, state *appstate.State, groupID int64) string {
	group, ok, err := db.GetGroup(ctx, state.DB, groupID)
	if err != nil || !ok {
		return "#" + strconv.FormatInt(groupID, 10)
	}
	return group.Name
}
