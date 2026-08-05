package call

import (
	"testing"
	"time"
)

// Magrathea's gateway answers 415 to an RTP/SAVP offer; Twilio answers 488.
// Both (plus 606) must trigger the plaintext downgrade; unrelated failures
// (busy, not found, server error) must not.
func TestIsSRTPMediaReject(t *testing.T) {
	for _, code := range []int{415, 488, 606} {
		if !isSRTPMediaReject(code) {
			t.Errorf("code %d must trigger the SRTP downgrade", code)
		}
	}
	for _, code := range []int{404, 403, 486, 480, 500, 503, 401, 407} {
		if isSRTPMediaReject(code) {
			t.Errorf("code %d must NOT trigger the SRTP downgrade", code)
		}
	}
}

// Every trunk call is dialled through the same upstream SBC host, so the
// avoid-cache must key on the routing headers, not the destination.
func TestSRTPRouteKeyPreference(t *testing.T) {
	dest := "sip:443300889471@outbound.sbc.example:5060"
	if k := srtpRouteKey(map[string]string{"X-Aplisay-Trunk": "magrathea"}, dest); k != "trunk:magrathea" {
		t.Errorf("trunk header must win: got %q", k)
	}
	if k := srtpRouteKey(map[string]string{"X-Aplisay-PhoneRegistration": "reg-1"}, dest); k != "reg:reg-1" {
		t.Errorf("registration header must be used when no trunk: got %q", k)
	}
	if k := srtpRouteKey(map[string]string{}, dest); k != "dest:"+dest {
		t.Errorf("destination fallback: got %q", k)
	}
	// Trunk beats registration when both are present (trunk identifies the
	// carrier hop, which is what rejects the SDP).
	both := map[string]string{"X-Aplisay-Trunk": "magrathea", "X-Aplisay-PhoneRegistration": "reg-1"}
	if k := srtpRouteKey(both, dest); k != "trunk:magrathea" {
		t.Errorf("trunk must take precedence: got %q", k)
	}
}

func TestSRTPAvoidCacheRememberAndExpire(t *testing.T) {
	m := New(Config{MediaIP: "127.0.0.1"})
	key := "trunk:magrathea"

	if m.srtpRecentlyRejected(key) {
		t.Fatal("fresh manager must not remember any rejection")
	}
	m.noteSRTPRejected(key)
	if !m.srtpRecentlyRejected(key) {
		t.Fatal("rejection must be remembered inside the TTL")
	}
	// Different routes are independent.
	if m.srtpRecentlyRejected("trunk:other") {
		t.Fatal("unrelated route must not be affected")
	}

	// Age the entry past the TTL: it must read as expired AND be pruned.
	m.srtpAvoidMu.Lock()
	m.srtpAvoid[key] = time.Now().Add(-srtpAvoidTTL - time.Minute)
	m.srtpAvoidMu.Unlock()
	if m.srtpRecentlyRejected(key) {
		t.Fatal("expired rejection must not be remembered")
	}
	m.srtpAvoidMu.Lock()
	_, still := m.srtpAvoid[key]
	m.srtpAvoidMu.Unlock()
	if still {
		t.Fatal("expired entry must be pruned on read")
	}
}
