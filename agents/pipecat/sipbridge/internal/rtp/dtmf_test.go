package rtp

import "testing"

// The send path (EventCode + EncodeDTMF) must be the exact inverse of the
// receive path (Symbol + ParseDTMF) it was added alongside.

func TestEventCodeRoundTripWithSymbol(t *testing.T) {
	for _, sym := range []byte("0123456789*#") {
		code, ok := EventCode(sym)
		if !ok {
			t.Fatalf("EventCode(%q) ok=false; want a code", sym)
		}
		if got := (DTMFEvent{Event: code}).Symbol(); got != sym {
			t.Errorf("Symbol(EventCode(%q)) = %q; want %q", sym, got, sym)
		}
	}
}

func TestEventCodeValues(t *testing.T) {
	cases := map[byte]byte{'0': 0, '5': 5, '9': 9, '*': 10, '#': 11}
	for sym, want := range cases {
		got, ok := EventCode(sym)
		if !ok || got != want {
			t.Errorf("EventCode(%q) = (%d,%v); want (%d,true)", sym, got, ok, want)
		}
	}
}

func TestEventCodeRejectsUnsupported(t *testing.T) {
	// A-D (RFC 4733 12-15) are deliberately excluded, as is any non-keypad byte.
	for _, sym := range []byte("AaBbCcDd-+ x\t\x00") {
		if _, ok := EventCode(sym); ok {
			t.Errorf("EventCode(%q) accepted; want rejected (alphabet is 0-9,*,#)", sym)
		}
	}
}

func TestEncodeDTMFRoundTrip(t *testing.T) {
	cases := []struct {
		event    byte
		end      bool
		volume   uint8
		duration uint16
	}{
		{event: 1, end: false, volume: 10, duration: 160},
		{event: 11, end: true, volume: 0, duration: 1600},
		{event: 0, end: false, volume: 63, duration: 0},
		{event: 10, end: true, volume: 25, duration: 0xFFFF},
	}
	for _, c := range cases {
		payload := EncodeDTMF(c.event, c.end, c.volume, c.duration)
		if len(payload) != 4 {
			t.Fatalf("EncodeDTMF returned %d bytes; want 4", len(payload))
		}
		ev, ok := ParseDTMF(payload)
		if !ok {
			t.Fatalf("ParseDTMF failed on EncodeDTMF output %v", payload)
		}
		if ev.Event != c.event || ev.End != c.end || ev.Volume != c.volume || ev.Duration != c.duration {
			t.Errorf("round-trip mismatch: got %+v; want event=%d end=%v vol=%d dur=%d",
				*ev, c.event, c.end, c.volume, c.duration)
		}
	}
}

func TestEncodeDTMFWireLayout(t *testing.T) {
	// End bit is the top bit of byte 1; volume the low 6 bits; duration is
	// big-endian across bytes 2-3.
	p := EncodeDTMF(5, true, 10, 320)
	if p[0] != 5 {
		t.Errorf("event byte = %d; want 5", p[0])
	}
	if p[1]&0x80 == 0 {
		t.Errorf("End flag not set: byte1=%08b", p[1])
	}
	if p[1]&0x3F != 10 {
		t.Errorf("volume mangled: byte1=%08b; want low 6 bits = 10", p[1])
	}
	if p[2] != 0x01 || p[3] != 0x40 {
		t.Errorf("duration bytes = %#02x %#02x; want 0x01 0x40 (320)", p[2], p[3])
	}
}
