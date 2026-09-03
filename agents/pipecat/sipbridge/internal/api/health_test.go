package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/call"
)

// The k8s preStop drain hook matches on the literal substring
// `"active_calls":0` in this body, so the encoding must stay compact and
// the key must keep its name.
func TestHealthBodyIsDrainHookParseable(t *testing.T) {
	s := New(call.New(call.Config{}), "127.0.0.1:0", "")
	rec := httptest.NewRecorder()
	s.handleHealth(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	body := rec.Body.String()
	if !strings.Contains(body, `"active_calls":0`) {
		t.Fatalf("health body = %q; the preStop drain hook greps for \"active_calls\":0", body)
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("health body is not JSON: %v", err)
	}
	for _, key := range []string{"ok", "active_calls", "draining", "goroutines"} {
		if _, ok := parsed[key]; !ok {
			t.Errorf("health body missing %q", key)
		}
	}
	if parsed["draining"] != false {
		t.Errorf("draining = %v on a fresh server; want false", parsed["draining"])
	}
}
