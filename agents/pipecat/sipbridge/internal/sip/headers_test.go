package sip

import (
	"testing"

	"github.com/emiago/sipgo/sip"
)

func parseInvite(t *testing.T, from string) *sip.Request {
	t.Helper()
	raw := "INVITE sip:+441632960002@sipbridge.example.com SIP/2.0\r\n" +
		"Via: SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bK-1\r\n" +
		"From: " + from + "\r\n" +
		"To: <sip:+441632960002@sipbridge.example.com>\r\n" +
		"Call-ID: abc@203.0.113.9\r\n" +
		"CSeq: 1 INVITE\r\n" +
		"X-Aplisay-Trunk: tk-1\r\n" +
		"X-Customer-ID: 42\r\n" +
		"Content-Length: 0\r\n\r\n"
	msg, err := sip.NewParser().ParseSIP([]byte(raw))
	if err != nil {
		t.Fatalf("parse INVITE: %v", err)
	}
	req, ok := msg.(*sip.Request)
	if !ok {
		t.Fatalf("parsed %T, want *sip.Request", msg)
	}
	return req
}

// extractHeaders must surface the From display-name (quoted-string and bare
// token forms) alongside the URI, and leave it empty when there is none —
// without disturbing the X- header extraction.
func TestExtractHeadersFromDisplayName(t *testing.T) {
	cases := []struct{ from, wantName, wantFrom string }{
		{
			`"Alice Smith" <sip:+441632960001@pbx.example.com>;tag=1928301774`,
			"Alice Smith",
			"sip:+441632960001@pbx.example.com",
		},
		{
			`Alice Smith <sip:+441632960001@pbx.example.com>;tag=1`,
			"Alice Smith",
			"sip:+441632960001@pbx.example.com",
		},
		{
			// sipgo keeps quoted-pairs as-is; the worker resolves them.
			`"Smith, \"Ali\"" <sip:+441632960001@pbx.example.com>;tag=1`,
			`Smith, \"Ali\"`,
			"sip:+441632960001@pbx.example.com",
		},
		{
			`<sip:+441632960001@pbx.example.com>;tag=1`,
			"",
			"sip:+441632960001@pbx.example.com",
		},
		{
			`sip:+441632960001@pbx.example.com;tag=1`,
			"",
			"sip:+441632960001@pbx.example.com",
		},
	}
	for _, c := range cases {
		h := extractHeaders(parseInvite(t, c.from))
		if h.FromDisplayName != c.wantName {
			t.Errorf("From %q: FromDisplayName = %q, want %q", c.from, h.FromDisplayName, c.wantName)
		}
		if h.From != c.wantFrom {
			t.Errorf("From %q: From = %q, want %q", c.from, h.From, c.wantFrom)
		}
		if h.AplisayTrunk != "tk-1" {
			t.Errorf("From %q: AplisayTrunk = %q, want tk-1", c.from, h.AplisayTrunk)
		}
		if h.Extra["x-customer-id"] != "42" {
			t.Errorf("From %q: Extra = %v, want x-customer-id=42", c.from, h.Extra)
		}
	}
}
