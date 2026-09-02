// Package codec provides minimal G.711 encoders/decoders and an
// 8↔16 kHz resampler.
//
// We keep this hand-rolled (no cgo opus / soxr) for the Phase A inbound
// path: PCMU and PCMA are deterministic mu-law / A-law lookup tables, no
// licensing, no native deps. Opus support lands in Phase E when we plug
// in `hraban/opus` (or equivalent) — kept out of the v1 build so the
// container stays cgo-free.
//
// All decoders produce / all encoders consume host-endian s16 PCM. The
// RTP/SIP side is 8 kHz mono; the Pipecat side is 16 kHz mono. The
// resampler in this package bridges the two cleanly.
package codec

// DecodePCMU decodes an RTP G.711 mu-law payload (8 kHz mono, 1
// byte/sample) to s16 PCM. Output is twice the input byte count.
func DecodePCMU(payload []byte) []int16 {
	out := make([]int16, len(payload))
	for i, b := range payload {
		out[i] = pcmuToLinear[b]
	}
	return out
}

// EncodePCMU encodes s16 PCM to G.711 mu-law. Input must be 8 kHz mono.
func EncodePCMU(samples []int16) []byte {
	out := make([]byte, len(samples))
	for i, s := range samples {
		out[i] = linearToPCMU(s)
	}
	return out
}

// DecodePCMA decodes an RTP G.711 A-law payload to s16 PCM.
func DecodePCMA(payload []byte) []int16 {
	out := make([]int16, len(payload))
	for i, b := range payload {
		out[i] = pcmaToLinear[b]
	}
	return out
}

// EncodePCMA encodes s16 PCM to G.711 A-law.
func EncodePCMA(samples []int16) []byte {
	out := make([]byte, len(samples))
	for i, s := range samples {
		out[i] = linearToPCMA(s)
	}
	return out
}

// PCMS16LEToBytes converts host-endian int16 samples to bytes
// (little-endian) for the wire — what Pipecat's WS transport expects.
func PCMS16LEToBytes(samples []int16) []byte {
	out := make([]byte, len(samples)*2)
	for i, s := range samples {
		u := uint16(s)
		out[i*2] = byte(u)
		out[i*2+1] = byte(u >> 8)
	}
	return out
}

// BytesToPCMS16LE converts little-endian s16 bytes back to int16
// samples. Pipecat sends AudioRawFrame.audio in this form.
func BytesToPCMS16LE(b []byte) []int16 {
	n := len(b) / 2
	out := make([]int16, n)
	for i := 0; i < n; i++ {
		out[i] = int16(uint16(b[i*2]) | uint16(b[i*2+1])<<8)
	}
	return out
}

// -- mu-law lookup table generation, computed at init -----------------------
//
// The ITU-T G.711 mu-law formula:
//   - bias = 0x84
//   - input s16, take absolute value + bias, find leading-1 position to
//     get exponent, take next 4 bits as mantissa.
//   - sign bit goes in bit 7 (inverted: 1 = positive).
//   - bytes are bit-complemented before transmission.
//
// Decoding inverts the process. Pre-compute both directions into 256-
// entry tables so the hot path is one memory access per sample.

var (
	pcmuToLinear [256]int16
	pcmaToLinear [256]int16
)

func init() {
	for i := 0; i < 256; i++ {
		pcmuToLinear[i] = mulawDecodeByte(byte(i))
		pcmaToLinear[i] = alawDecodeByte(byte(i))
	}
}

func mulawDecodeByte(b byte) int16 {
	b = ^b
	sign := b & 0x80
	exp := (b >> 4) & 0x07
	mant := b & 0x0F
	sample := int16(((int(mant) << 3) + 0x84) << exp)
	sample -= 0x84
	if sign != 0 {
		sample = -sample
	}
	return sample
}

func linearToPCMU(s int16) byte {
	const bias = 0x84
	const clip = 32635
	sign := byte(0)
	v := int(s)
	if v < 0 {
		v = -v
		sign = 0x80
	}
	if v > clip {
		v = clip
	}
	v += bias
	// find segment
	exp := byte(7)
	for mask := 0x4000; (v&mask) == 0 && exp > 0; mask >>= 1 {
		exp--
	}
	mant := byte((v >> (int(exp) + 3)) & 0x0F)
	return ^(sign | (exp << 4) | mant)
}

// -- A-law (ITU-T G.711 §A / RFC 3551 PCMA) -----------------------------
//
// A-law codes a 13-bit magnitude (s16 >> 3) in eight segments. Segment 0
// is linear (mantissa is bits 4..1 of the 13-bit value), segments 1..7 are
// 4-bit mantissas at successively coarser steps. The sign bit (0x80 after
// the 0x55 mask) is SET for positive samples — the opposite of mu-law —
// and every byte is XORed with 0x55 on the wire so runs of silence do not
// look like an all-zeros/all-ones line. The step tables below are the
// segment upper bounds of the 13-bit magnitude, as in the reference
// implementation (Sun Microsystems g711.c, ITU-T G.711 Table 1a).
var alawSegmentEnd = [8]int{0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF}

func alawDecodeByte(b byte) int16 {
	b ^= 0x55
	t := int(b&0x0F) << 4
	seg := (b & 0x70) >> 4
	switch seg {
	case 0:
		t += 8
	case 1:
		t += 0x108
	default:
		t += 0x108
		t <<= seg - 1
	}
	if b&0x80 != 0 {
		return int16(t)
	}
	return int16(-t)
}

func linearToPCMA(s int16) byte {
	// Work on the 13-bit magnitude the codec is defined over.
	v := int(s) >> 3
	mask := byte(0xD5) // positive: sign bit set, then the 0x55 line mask
	if v < 0 {
		mask = 0x55
		v = -v - 1
	}
	seg := 0
	for seg < 8 && v > alawSegmentEnd[seg] {
		seg++
	}
	if seg >= 8 {
		// Beyond the top segment: saturate to the largest code.
		return 0x7F ^ mask
	}
	var mant int
	if seg < 2 {
		mant = (v >> 1) & 0x0F
	} else {
		mant = (v >> seg) & 0x0F
	}
	return byte(seg<<4|mant) ^ mask
}
