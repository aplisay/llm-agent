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
	for mask := 0x4000; (v & mask) == 0 && exp > 0; mask >>= 1 {
		exp--
	}
	mant := byte((v >> (int(exp) + 3)) & 0x0F)
	return ^(sign | (exp << 4) | mant)
}

func alawDecodeByte(b byte) int16 {
	b ^= 0x55
	sign := b & 0x80
	exp := (b >> 4) & 0x07
	mant := b & 0x0F
	var sample int16
	if exp == 0 {
		sample = int16(int(mant)<<4) + 8
	} else {
		sample = int16(((int(mant) << 4) + 0x108) << (exp - 1))
	}
	if sign != 0 {
		sample = -sample
	}
	return sample
}

func linearToPCMA(s int16) byte {
	sign := byte(0x55) ^ 0x80
	v := int(s)
	if v >= 0 {
		sign = 0x55
	} else {
		v = -v - 1
	}
	if v > 32635 {
		v = 32635
	}
	var exp byte
	var mant byte
	if v < 256 {
		exp = 0
		mant = byte((v >> 4) & 0x0F)
	} else {
		exp = 1
		seg := v
		for seg >>= 8; seg > 0 && exp < 7; seg >>= 1 {
			exp++
		}
		mant = byte((v >> (int(exp) + 3)) & 0x0F)
	}
	return (exp<<4 | mant) ^ sign
}
