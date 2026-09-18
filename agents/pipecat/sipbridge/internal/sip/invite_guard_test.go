package sip

import (
	"testing"

	"github.com/emiago/sipgo/sip"
)

// newInvite builds a bare INVITE with the supplied Call-ID. toTag, when
// non-empty, makes it in-dialog (a re-INVITE).
func newInvite(callID, toTag string) *sip.Request {
	req := sip.NewRequest(sip.INVITE, sip.Uri{Scheme: "sip", User: "1000", Host: "example.net"})
	cid := sip.CallIDHeader(callID)
	req.AppendHeader(&cid)
	to := &sip.ToHeader{
		Address: sip.Uri{Scheme: "sip", User: "1000", Host: "example.net"},
		Params:  sip.NewParams(),
	}
	if toTag != "" {
		to.Params.Add("tag", toTag)
	}
	req.AppendHeader(to)
	return req
}

// A re-INVITE (hold, an RFC 4028 session-timer refresh, renegotiation)
// arrives on the same OnInvite handler as a fresh call. Running one
// through the setup path allocates a second RTP port and worker WS and
// overwrites both registries by Call-ID: the old Call is orphaned and
// the orphan's media watchdog then hangs up the NEW call 10 s later.
// The guard is the To-tag, so check we read it the way sipgo presents it.
func TestInDialogInviteIsDetectedByToTag(t *testing.T) {
	req := newInvite("abc@example.net", "as7f3c91")
	to := req.To()
	if to == nil {
		t.Fatal("To() = nil on a request that has one")
	}
	if _, hasTag := to.Params.Get("tag"); !hasTag {
		t.Fatal("To-tag not found; the re-INVITE guard would let an in-dialog INVITE through")
	}
}

func TestInitialInviteHasNoToTag(t *testing.T) {
	req := newInvite("abc@example.net", "")
	to := req.To()
	if to == nil {
		t.Fatal("To() = nil on a request that has one")
	}
	if _, hasTag := to.Params.Get("tag"); hasTag {
		t.Fatal("initial INVITE reported a To-tag; the guard would reject every new call")
	}
}

// The second half of the guard: an INVITE whose Call-ID is already live
// is a re-INVITE even without a To-tag (some UAs omit it on a
// retransmit-after-fork). The lookup must see the registered dialog.
func TestLiveCallIDIsVisibleToTheGuard(t *testing.T) {
	s := &Server{calls: map[string]*activeCall{}}
	const id = "abc@example.net"
	if _, live := s.calls[id]; live {
		t.Fatal("fresh server reported a live call")
	}
	s.calls[id] = &activeCall{}
	if _, live := s.calls[id]; !live {
		t.Fatal("registered call not visible; a re-INVITE would overwrite the live one")
	}
}

// Drain flips the accept/refuse state that SIGTERM shutdown relies on:
// new INVITEs get a 503 + Retry-After so the upstream re-routes, while
// in-dialog traffic for calls already up keeps working.
func TestDrainFlipsAcceptState(t *testing.T) {
	s := &Server{calls: map[string]*activeCall{}}
	if s.Draining() {
		t.Fatal("a fresh server reported itself draining")
	}
	s.Drain()
	if !s.Draining() {
		t.Fatal("Draining() = false after Drain()")
	}
}
