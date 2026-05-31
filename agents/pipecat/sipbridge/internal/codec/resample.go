package codec

// Upsample8To16 doubles the sample rate from 8 kHz to 16 kHz using a
// simple linear interpolation between successive samples.
//
// Linear interpolation between two samples at 8 kHz produces a mild low-
// pass effect (the new midpoint sample is the average of its neighbours)
// — adequate for voice telephony, where the source PCMU/PCMA payload is
// already band-limited to ~3.4 kHz. A sharper anti-imaging filter (sinc
// kernel, polyphase FIR) would buy us nothing audible at this band and
// would cost CPU per packet. If we add Opus or G.722 (which can carry
// real wideband energy) we'll want a proper filter then, not now.
//
// Output length is exactly 2*len(in) samples.
func Upsample8To16(in []int16) []int16 {
	if len(in) == 0 {
		return nil
	}
	out := make([]int16, len(in)*2)
	for i, s := range in {
		out[i*2] = s
		if i+1 < len(in) {
			// Midpoint = average of this and next sample. Avoid int16
			// overflow by widening to int32 first.
			out[i*2+1] = int16((int32(s) + int32(in[i+1])) / 2)
		} else {
			// Last sample: repeat (no next sample to interpolate with).
			out[i*2+1] = s
		}
	}
	return out
}

// Downsample16To8 halves the sample rate from 16 kHz to 8 kHz by
// averaging consecutive pairs of samples — a 2-tap boxcar filter.
//
// Same band-limit argument as the upsampler: the PCMU/PCMA wire is
// limited to a 4 kHz Nyquist anyway, so an aggressive lowpass before
// decimation isn't needed. The 2-tap average attenuates the highest
// frequencies in the 16 kHz source enough to suppress audible aliasing
// for typical TTS output; if we ever hear it (whistles on sibilants),
// drop in a 9-tap FIR here.
//
// If len(in) is odd, the final sample is dropped (typical input lengths
// from Pipecat are multiples of 320 samples = 20 ms at 16 kHz so this
// never bites in practice).
func Downsample16To8(in []int16) []int16 {
	n := len(in) / 2
	out := make([]int16, n)
	for i := 0; i < n; i++ {
		a := int32(in[i*2])
		b := int32(in[i*2+1])
		out[i] = int16((a + b) / 2)
	}
	return out
}
