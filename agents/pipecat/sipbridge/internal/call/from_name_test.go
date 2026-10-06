package call

import "testing"

// The From display-name rides the WS handshake percent-encoded so that
// non-ASCII names survive the worker's latin-1 header decoding; empty names
// produce no header at all.
func TestFromNameHeaderValue(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Alice Smith", "Alice%20Smith"},
		{"Zoë", "Zo%C3%AB"},
		// sipgo keeps quoted-pairs: `Alice \"A\"` → backslash and quote escaped.
		{`Alice \"A\"`, "Alice%20%5C%22A%5C%22"},
		{"  padded  ", "padded"},
		{"", ""},
		{"   ", ""},
	}
	for _, c := range cases {
		if got := fromNameHeaderValue(c.in); got != c.want {
			t.Errorf("fromNameHeaderValue(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
