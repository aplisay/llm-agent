package pipecat

import "testing"

// The worker's ProtobufFrameSerializer ships caller barge-in as the Frame
// oneof's ``interruption`` branch (field 5, length-delimited InterruptionFrame
// carrying only id/name). DecodeFrame must surface it as a flag — this is the
// signal the bridge uses to drop queued-but-unsent paced bot audio.
func TestDecodeFrameInterruption(t *testing.T) {
	// Frame{interruption: InterruptionFrame{}} — field 5, wire type 2,
	// zero-length inner message.
	b := []byte{0x2a, 0x00}
	f, err := DecodeFrame(b)
	if err != nil {
		t.Fatalf("DecodeFrame: %v", err)
	}
	if !f.Interruption {
		t.Fatal("Interruption flag not set for oneof branch 5")
	}
	if f.Audio != nil || f.Text != nil || f.Transcription != nil || f.Message != nil {
		t.Fatal("unexpected sibling branches set")
	}

	// Inner id/name fields present (id=7, name="x") — still just a flag.
	inner := []byte{0x08, 0x07, 0x12, 0x01, 'x'}
	b = append([]byte{0x2a, byte(len(inner))}, inner...)
	f, err = DecodeFrame(b)
	if err != nil {
		t.Fatalf("DecodeFrame (populated inner): %v", err)
	}
	if !f.Interruption {
		t.Fatal("Interruption flag not set when inner fields are populated")
	}
}

// Unknown future oneof branches must still be skipped without error.
func TestDecodeFrameUnknownBranchIgnored(t *testing.T) {
	b := []byte{0x32, 0x00} // field 6, wire type 2, empty
	f, err := DecodeFrame(b)
	if err != nil {
		t.Fatalf("DecodeFrame: %v", err)
	}
	if f.Interruption || f.Audio != nil || f.Text != nil || f.Transcription != nil || f.Message != nil {
		t.Fatal("unknown branch must decode to an empty IncomingFrame")
	}
}
