package codec

import "testing"

// refAlawExpand is ITU-T G.711 Table 1a written out directly: the decoded
// 13-bit magnitude for a (segment, mantissa) pair, independent of the
// lookup-table construction in g711.go.
func refAlawExpand(code byte) int {
	c := code ^ 0x55
	seg := int(c>>4) & 7
	mant := int(c & 0x0F)
	var mag int
	if seg == 0 {
		mag = 2*mant + 1
	} else {
		mag = (32 + 2*mant + 1) << (seg - 1)
	}
	if c&0x80 == 0 {
		mag = -mag
	}
	return mag << 3 // back to the s16 scale
}

// refMulawExpand is G.711 Table 2a (mu-law, bias 33 on the 14-bit scale).
func refMulawExpand(code byte) int {
	c := ^code
	seg := int(c>>4) & 7
	mant := int(c & 0x0F)
	mag := ((2*mant + 33) << seg) - 33
	if c&0x80 != 0 {
		mag = -mag
	}
	return mag << 2 // 14-bit → s16 scale
}

// G.711 is a truncating quantiser: each code owns a decision interval
// centred on its expansion, half a segment step either side, and the
// s16 input is first truncated to the codec's 13-bit (A-law) or 14-bit
// (mu-law) scale. A correct encoder therefore emits a code whose
// interval contains the input; picking the "nearest" expansion is NOT
// the standard and differs at segment boundaries. These return the
// half-step of a code's segment on the s16 scale, plus the truncation
// slop, so the tests assert exactly the property the standard defines.
func alawHalfStep(code byte) int {
	seg := int((code^0x55)>>4) & 7
	half := 1 // seg 0 and 1 both step by 2 on the 13-bit scale
	if seg > 1 {
		half = 1 << (seg - 1)
	}
	return half*8 + 7
}

func mulawHalfStep(code byte) int {
	seg := int((^code)>>4) & 7
	return (1<<seg)*4 + 3
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func TestAlawDecodeMatchesG711Table(t *testing.T) {
	for c := 0; c < 256; c++ {
		if got, want := int(alawDecodeByte(byte(c))), refAlawExpand(byte(c)); got != want {
			t.Fatalf("alaw decode 0x%02x = %d, want %d", c, got, want)
		}
	}
}

func TestMulawDecodeMatchesG711Table(t *testing.T) {
	for c := 0; c < 256; c++ {
		if got, want := int(mulawDecodeByte(byte(c))), refMulawExpand(byte(c)); got != want {
			t.Fatalf("mulaw decode 0x%02x = %d, want %d", c, got, want)
		}
	}
}

// Every s16 input must land inside the decision interval of the code the
// encoder emits. This is the property the old A-law encoder broke: it
// picked a segment one too high for everything between 256 and 16383,
// doubling the level, then fell back to the right one above that.
func TestAlawEncodeStaysInInterval(t *testing.T) {
	for s := -32768; s <= 32767; s++ {
		got := linearToPCMA(int16(s))
		if got == 0xAA || got == 0x2A {
			// Full-scale codes own everything beyond their expansion.
			if abs(s) >= abs(refAlawExpand(got))-alawHalfStep(got) {
				continue
			}
		}
		if err := abs(refAlawExpand(got) - s); err > alawHalfStep(got) {
			t.Fatalf("alaw encode %d = 0x%02x (decodes to %d, error %d): input outside the code's interval",
				s, got, refAlawExpand(got), err)
		}
	}
}

func TestMulawEncodeStaysInInterval(t *testing.T) {
	for s := -32768; s <= 32767; s++ {
		got := linearToPCMU(int16(s))
		if got == 0x00 || got == 0x80 {
			// Full-scale codes own everything beyond their expansion.
			if abs(s) >= abs(refMulawExpand(got))-mulawHalfStep(got) {
				continue
			}
		}
		if err := abs(refMulawExpand(got) - s); err > mulawHalfStep(got) {
			t.Fatalf("mulaw encode %d = 0x%02x (decodes to %d, error %d): input outside the code's interval",
				s, got, refMulawExpand(got), err)
		}
	}
}

func TestAlawKnownCodes(t *testing.T) {
	cases := []struct {
		in   int16
		want byte
	}{
		{0, 0xD5},      // smallest positive step, line-masked
		{-8, 0x55},     // smallest negative step
		{32767, 0xAA},  // positive full scale
		{-32768, 0x2A}, // negative full scale
		{1000, 0xFA},   // 13-bit 125: seg 2, mant 15 → decodes to 1008
	}
	for _, c := range cases {
		if got := linearToPCMA(c.in); got != c.want {
			t.Errorf("alaw encode %d = 0x%02x, want 0x%02x", c.in, got, c.want)
		}
	}
}

// The decoded output must never move the other way from the input: a
// non-monotonic codec turns loud peaks into sudden drops.
func TestAlawRoundTripIsMonotonic(t *testing.T) {
	prev := int(alawDecodeByte(linearToPCMA(-32768)))
	for s := -32767; s <= 32767; s++ {
		cur := int(alawDecodeByte(linearToPCMA(int16(s))))
		if cur < prev {
			t.Fatalf("alaw round trip not monotonic at %d: %d after %d", s, cur, prev)
		}
		prev = cur
	}
}

func TestEncodeDecodeSlices(t *testing.T) {
	in := []int16{0, 300, -300, 1000, -1000, 8000, -8000, 20000, -20000}
	for i, s := range DecodePCMA(EncodePCMA(in)) {
		if d := abs(int(s) - int(in[i])); d > abs(int(in[i]))/16+16 {
			t.Errorf("PCMA round trip %d → %d", in[i], s)
		}
	}
	for i, s := range DecodePCMU(EncodePCMU(in)) {
		if d := abs(int(s) - int(in[i])); d > abs(int(in[i]))/16+16 {
			t.Errorf("PCMU round trip %d → %d", in[i], s)
		}
	}
}
