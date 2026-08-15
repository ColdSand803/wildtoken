package proxy

import (
	"bytes"
	"context"
	"sync"
)

// bufferedStream carries a non-streaming response downstream and writes its log
// once the handler is done with it.
//
// The log used to be written the moment the upstream body had been read, which
// is before a single byte reaches the client. A client that left while the
// response was being delivered was therefore recorded as whatever the upstream
// answered — a 200 for a request nobody received — while the streaming path
// recorded the same event as a 499. Filtering the console for client aborts
// showed only half of them, and the half it showed depended on whether the model
// happened to stream.
//
// Deferring to Close is what the SSE path already does, for the same reason.
type bufferedStream struct {
	body       *bytes.Reader
	requestCtx context.Context
	deps       Deps
	// upstreamStatus is what the channel answered, which is what the log
	// records when the client was still there to receive it.
	upstreamStatus int32

	// mu guards entry so that a body closed more than once — a retry
	// abandoning it, then the handler closing what it wrote — logs once.
	mu    sync.Mutex
	entry *LogEntry
}

func newBufferedStream(requestCtx context.Context, body []byte, entry LogEntry,
	deps Deps, upstreamStatus int32) *bufferedStream {
	return &bufferedStream{
		body:           bytes.NewReader(body),
		requestCtx:     requestCtx,
		deps:           deps,
		upstreamStatus: upstreamStatus,
		entry:          &entry,
	}
}

func (s *bufferedStream) Read(buffer []byte) (int, error) {
	return s.body.Read(buffer)
}

// Close writes the log, attributing the outcome to whichever side ended the
// request.
func (s *bufferedStream) Close() error {
	s.mu.Lock()
	entry := s.entry
	s.entry = nil
	s.mu.Unlock()

	if entry == nil {
		return nil
	}

	if s.requestCtx.Err() != nil {
		clientGone := int32(499)
		entry.StatusCode = &clientGone
		entry.Error = ptrTo("client disconnected before the response was delivered")
	}
	s.deps.LogWriter.Schedule(*entry)
	return nil
}
