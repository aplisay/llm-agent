package sip

import (
	"testing"

	"github.com/emiago/sipgo/sip"
)

// testServer is the minimal Server needed to exercise Contact building —
// contactURI reads only the advertised address and the two ports.
func testServer() *Server {
	return &Server{
		signalIP:      "198.51.100.7",
		signalPort:    5060,
		tlsSignalPort: 5061,
	}
}

// A TLS dialog must advertise sips: on the TLS port with ;transport=tls.
// Anything else and the peer aims in-dialog requests (ACK, BYE) at UDP
// 5060, where a TLS-only deployment isn't listening — the failure that
// left outbound legs hanging until the RTP watchdog reaped them.
func TestContactURITLS(t *testing.T) {
	s := testServer()
	for _, transport := range []string{"tls", "TLS", "wss"} {
		uri := s.contactURI(transport)
		if uri.Scheme != "sips" {
			t.Errorf("%s: scheme = %q, want sips", transport, uri.Scheme)
		}
		if uri.Port != 5061 {
			t.Errorf("%s: port = %d, want the TLS port 5061", transport, uri.Port)
		}
		if got := uri.UriParams.GetOr("transport", ""); got != "tls" {
			t.Errorf("%s: transport param = %q, want tls", transport, got)
		}
		if uri.Host != "198.51.100.7" {
			t.Errorf("%s: host = %q, want the advertised signal IP", transport, uri.Host)
		}
	}
}

// Plaintext transports keep the sip:/UDP-port form.
func TestContactURIPlaintext(t *testing.T) {
	s := testServer()
	for _, transport := range []string{"", "udp", "UDP", "tcp"} {
		uri := s.contactURI(transport)
		if uri.Scheme == "sips" {
			t.Errorf("%q: got sips scheme on a plaintext transport", transport)
		}
		if uri.Port != 5060 {
			t.Errorf("%q: port = %d, want the UDP port 5060", transport, uri.Port)
		}
		if got := uri.UriParams.GetOr("transport", ""); got == "tls" {
			t.Errorf("%q: advertised transport=tls on a plaintext transport", transport)
		}
	}
}

// When no TLS port is configured we must not invent one — fall back to
// the signalling port rather than advertising 0.
func TestContactURITLSWithoutTLSPort(t *testing.T) {
	s := testServer()
	s.tlsSignalPort = 0
	if got := s.contactURI("tls").Port; got != 5060 {
		t.Errorf("port = %d, want fallback to 5060 when no TLS port is set", got)
	}
}

// isTLSURI drives the outbound Contact choice, so it has to recognise
// both spellings a carrier / SBC target can arrive in.
func TestIsTLSURI(t *testing.T) {
	tlsParams := sip.NewParams()
	tlsParams.Add("transport", "tls")
	udpParams := sip.NewParams()
	udpParams.Add("transport", "udp")
	mixedParams := sip.NewParams()
	mixedParams.Add("transport", "TLS")

	cases := []struct {
		name string
		uri  sip.Uri
		want bool
	}{
		{"sips scheme", sip.Uri{Scheme: "sips", Host: "sbc.example.net", Port: 5061}, true},
		{"sips uppercase", sip.Uri{Scheme: "SIPS", Host: "sbc.example.net"}, true},
		{"transport param", sip.Uri{Host: "sbc.example.net", Port: 5061, UriParams: tlsParams}, true},
		{"transport param mixed case", sip.Uri{Host: "sbc.example.net", UriParams: mixedParams}, true},
		{"plain sip", sip.Uri{Scheme: "sip", Host: "sbc.example.net", Port: 5060}, false},
		{"explicit udp", sip.Uri{Scheme: "sip", Host: "sbc.example.net", UriParams: udpParams}, false},
		{"bare uri, no params", sip.Uri{Host: "sbc.example.net"}, false},
	}
	for _, c := range cases {
		if got := isTLSURI(c.uri); got != c.want {
			t.Errorf("%s: isTLSURI = %v, want %v", c.name, got, c.want)
		}
	}
}
