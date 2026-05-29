// Package api implements sipbridge's HTTP control surface.
//
// Phase A endpoints:
//   GET  /health            liveness + active-call count
//   DELETE /v1/calls/{id}   hangup (caller-initiated)
//
// Phase B adds:
//   POST /v1/calls          outbound originate
//   POST /v1/calls/{id}/transfer  blind / attended REFER
//
// All endpoints require a Bearer token if SIPBRIDGE_API_TOKEN is set
// in the environment; auth is disabled when the token is empty for
// straightforward dev bring-up.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/rs/zerolog/log"

	"github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/call"
)

type Server struct {
	mgr   *call.Manager
	token string
	hs    *http.Server
}

func New(mgr *call.Manager, addr, token string) *Server {
	mux := http.NewServeMux()
	s := &Server{mgr: mgr, token: token}

	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("DELETE /v1/calls/{id}", s.handleHangup)
	mux.HandleFunc("POST /v1/calls", s.handleOriginate)
	mux.HandleFunc("POST /v1/calls/{id}/transfer", s.handleTransfer)
	mux.HandleFunc("POST /v1/calls/{id}/consult", s.handleConsult)

	s.hs = &http.Server{
		Addr:              addr,
		Handler:           s.withAuth(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	return s
}

func (s *Server) ListenAndServe() error {
	log.Info().Str("addr", s.hs.Addr).Msg("api: listening")
	if err := s.hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func (s *Server) Shutdown(ctx context.Context) error {
	return s.hs.Shutdown(ctx)
}

// withAuth wraps the mux with a Bearer-token check, skipping /health so
// readiness probes don't need the token.
func (s *Server) withAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.token != "" && r.URL.Path != "/health" {
			h := r.Header.Get("Authorization")
			if !strings.HasPrefix(h, "Bearer ") || strings.TrimSpace(h[len("Bearer "):]) != s.token {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":            true,
		"active_calls":  len(s.mgr.ActiveCallIDs()),
	})
}

func (s *Server) handleHangup(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing call id")
		return
	}
	if err := s.mgr.Hangup(r.Context(), id); err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// originateBody mirrors what the worker's
// ``SipBridgeSipGateway.originate`` POSTs us. ``custom_headers`` are
// stamped on the outbound INVITE; ``metadata.aplisay_call_id`` is
// promoted to X-Aplisay-Call-Id automatically by the call manager so
// callers don't have to duplicate it in both places.
type originateBody struct {
	Destination       string            `json:"destination"`
	CallerID          string            `json:"caller_id"`
	AgentWSSessionID  string            `json:"agent_ws_session_id"`
	CustomHeaders     map[string]string `json:"custom_headers"`
	Metadata          map[string]string `json:"metadata"`
}

func (s *Server) handleOriginate(w http.ResponseWriter, r *http.Request) {
	var body originateBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if body.Destination == "" {
		writeErr(w, http.StatusBadRequest, "missing destination")
		return
	}
	if body.AgentWSSessionID == "" {
		writeErr(w, http.StatusBadRequest, "missing agent_ws_session_id")
		return
	}

	// Don't tie the SIP transaction to the HTTP request's context —
	// dialing can take ~5s (carrier ringback) and we want a clean
	// 200 OK with the bridge call_id back to the worker, not a
	// caller-cancelled hang. Use a fresh ctx with our own timeout.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	callID, err := s.mgr.Originate(ctx, call.OriginateParams{
		Destination:    body.Destination,
		CallerID:       body.CallerID,
		AgentSessionID: body.AgentWSSessionID,
		CustomHeaders:  body.CustomHeaders,
		Metadata:       body.Metadata,
	})
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"ok":      true,
		"call_id": callID,
	})
}

// transferBody for POST /v1/calls/{id}/transfer.
type transferBody struct {
	Target string `json:"target"` // SIP URI / bare number (blind, dial_bridge) or call_id (bridged, attended)
	// "blind"      — in-dialog REFER on this call to ``target`` (number/URI).
	// "bridged"    — media relay between this call and ``target`` (a consult call_id).
	// "attended"   — REFER this call to a consult target with ?Replaces of the
	//                consult dialog (``target`` is the consult call_id). RFC 3891.
	// "dial_bridge" — native blind bridged transfer: dial ``target``
	//                (number/URI) as a fresh agent-less leg and relay
	//                media to this call. Used when the carrier doesn't
	//                honour REFER. ``caller_id`` / ``custom_headers`` are
	//                stamped on the new outbound INVITE.
	Mode string `json:"mode"`
	// CallerID / CustomHeaders / Metadata apply only to mode
	// "dial_bridge", where a new outbound INVITE is placed.
	CallerID      string            `json:"caller_id"`
	CustomHeaders map[string]string `json:"custom_headers"`
	Metadata      map[string]string `json:"metadata"`
}

func (s *Server) handleTransfer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing call id")
		return
	}
	var body transferBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if body.Target == "" {
		writeErr(w, http.StatusBadRequest, "missing target")
		return
	}

	// dial_bridge places a fresh outbound INVITE, so give it the same
	// long timeout as originate (carrier ringback can take seconds) and
	// route it to the dedicated dial+relay primitive rather than the
	// in-dialog Transfer switch.
	if body.Mode == "dial_bridge" {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		relayID, err := s.mgr.DialAndBridge(ctx, call.DialBridgeParams{
			OriginalCallID: id,
			Destination:    body.Target,
			CallerID:       body.CallerID,
			CustomHeaders:  body.CustomHeaders,
			Metadata:       body.Metadata,
		})
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":           true,
			"relay_call_id": relayID,
		})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := s.mgr.Transfer(ctx, id, body.Target, body.Mode); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// consultBody for POST /v1/calls/{id}/consult — dials a consult leg
// that runs independently of the original call. Returns the new call
// id, which the worker passes back as ``target`` (mode "bridged") to
// /transfer when ready to finalize.
type consultBody struct {
	Destination       string            `json:"destination"`
	CallerID          string            `json:"caller_id"`
	AgentWSSessionID  string            `json:"agent_ws_session_id"`
	CustomHeaders     map[string]string `json:"custom_headers"`
	Metadata          map[string]string `json:"metadata"`
}

func (s *Server) handleConsult(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing call id")
		return
	}
	var body consultBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if body.Destination == "" {
		writeErr(w, http.StatusBadRequest, "missing destination")
		return
	}
	if body.AgentWSSessionID == "" {
		writeErr(w, http.StatusBadRequest, "missing agent_ws_session_id")
		return
	}
	// Same long-timeout reasoning as handleOriginate — carrier ringback
	// for the consult leg can take several seconds.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	consultID, err := s.mgr.Consult(ctx, call.ConsultParams{
		OriginalCallID:  id,
		Destination:     body.Destination,
		CallerID:        body.CallerID,
		AgentSessionID:  body.AgentWSSessionID,
		CustomHeaders:   body.CustomHeaders,
		Metadata:        body.Metadata,
	})
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"ok":             true,
		"consult_call_id": consultID,
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}
