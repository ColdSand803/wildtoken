// Package apperr maps domain failures onto HTTP responses.
package apperr

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
)

// Kind classifies an AppError so handlers can map it onto a status code.
type Kind int

const (
	KindNotFound Kind = iota
	KindBadRequest
	KindConflict
	KindUpstream
	KindInternal
	KindDatabase
	KindJSON
)

// AppError is the error type every handler returns.
type AppError struct {
	Kind Kind
	Msg  string
	Err  error
}

func (e *AppError) Error() string {
	prefix := map[Kind]string{
		KindNotFound:   "not found",
		KindBadRequest: "bad request",
		KindConflict:   "conflict",
		KindUpstream:   "upstream error",
		KindInternal:   "internal error",
		KindDatabase:   "database error",
		KindJSON:       "JSON error",
	}[e.Kind]
	if e.Err != nil && e.Msg == "" {
		return fmt.Sprintf("%s: %v", prefix, e.Err)
	}
	return fmt.Sprintf("%s: %s", prefix, e.Msg)
}

func (e *AppError) Unwrap() error { return e.Err }

func NotFound(msg string) *AppError   { return &AppError{Kind: KindNotFound, Msg: msg} }
func BadRequest(msg string) *AppError { return &AppError{Kind: KindBadRequest, Msg: msg} }
func Conflict(msg string) *AppError   { return &AppError{Kind: KindConflict, Msg: msg} }
func Upstream(msg string) *AppError   { return &AppError{Kind: KindUpstream, Msg: msg} }
func Internal(msg string) *AppError   { return &AppError{Kind: KindInternal, Msg: msg} }

// Database wraps a driver failure; the detail stays in the log, not the response.
func Database(err error) *AppError { return &AppError{Kind: KindDatabase, Err: err} }

// JSON wraps a serialization failure.
func JSON(err error) *AppError { return &AppError{Kind: KindJSON, Err: err} }

// StatusAndMessage returns the client-visible status and message, logging the
// details of failures that must not leak to the caller.
func (e *AppError) StatusAndMessage() (int, string) {
	switch e.Kind {
	case KindNotFound:
		return http.StatusNotFound, e.Msg
	case KindBadRequest:
		return http.StatusBadRequest, e.Msg
	case KindConflict:
		return http.StatusConflict, e.Msg
	case KindUpstream:
		return http.StatusBadGateway, e.Msg
	case KindDatabase:
		slog.Error("database error", "error", e.Err)
		return http.StatusInternalServerError, "internal database error"
	case KindJSON:
		slog.Error("JSON error", "error", e.Err)
		return http.StatusInternalServerError, "internal JSON error"
	default:
		return http.StatusInternalServerError, "internal server error"
	}
}

// Write renders the error as the `{"error": ...}` body every client expects.
func (e *AppError) Write(w http.ResponseWriter) {
	status, message := e.StatusAndMessage()
	WriteJSON(w, status, map[string]string{"error": message})
}

// WriteJSON serializes value as a JSON response body.
func WriteJSON(w http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		slog.Error("could not serialize response", "error", err)
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"internal JSON error"}`))
		return
	}
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	w.Write(body)
}

// WriteError renders any error, treating non-AppError values as internal.
func WriteError(w http.ResponseWriter, err error) {
	var appErr *AppError
	if e, ok := err.(*AppError); ok {
		appErr = e
	} else {
		appErr = Internal(err.Error())
	}
	appErr.Write(w)
}
