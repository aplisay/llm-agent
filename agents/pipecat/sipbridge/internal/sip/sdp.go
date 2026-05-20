package sip

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/pion/sdp/v3"

	"github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/rtp"
)

// CodecOffer summarises what the far end supports, after parsing the
// SDP offer. We currently only care about G.711 mu-law / A-law for
// Phase A; Opus and G.722 will land here in Phase E as we add codec
// negotiation logic.
type CodecOffer struct {
	HasPCMU      bool
	HasPCMA      bool
	RemoteIP     string
	RemotePort   int
	// Direction of the m=audio line (sendrecv / sendonly / recvonly /
	// inactive). Hold (a=sendonly / a=inactive) is signalled this way
	// — we honour it on the audio bridge but don't tear down the call.
	Direction string
}

// ParseOffer extracts the codecs + remote RTP endpoint from a SIP
// INVITE's SDP body. Returns an error only on actually-malformed SDP;
// missing-but-optional fields produce zero-values for downstream
// inspection.
func ParseOffer(body []byte) (*CodecOffer, error) {
	var sess sdp.SessionDescription
	if err := sess.UnmarshalString(string(body)); err != nil {
		return nil, fmt.Errorf("sdp: parse offer: %w", err)
	}
	if len(sess.MediaDescriptions) == 0 {
		return nil, errors.New("sdp: no m= line")
	}
	// First audio m= line wins. We could iterate to find the first
	// non-rejected one in theory, but RFC 3264 says the first matching
	// media stream is the one to answer; carrier SBCs send a single
	// audio m= in practice.
	var audio *sdp.MediaDescription
	for _, m := range sess.MediaDescriptions {
		if m.MediaName.Media == "audio" {
			audio = m
			break
		}
	}
	if audio == nil {
		return nil, errors.New("sdp: no audio m= line")
	}

	out := &CodecOffer{
		Direction: directionOf(audio),
	}

	// Remote IP comes from media-level c= line if present, else
	// session-level c= line (per RFC 4566 §5.7).
	if audio.ConnectionInformation != nil {
		out.RemoteIP = audio.ConnectionInformation.Address.Address
	} else if sess.ConnectionInformation != nil {
		out.RemoteIP = sess.ConnectionInformation.Address.Address
	}
	out.RemotePort = audio.MediaName.Port.Value

	// Codec presence: walk the m= formats list. Static payload types 0
	// (PCMU) and 8 (PCMA) don't need a=rtpmap to identify (RFC 3551
	// §6) — but they often have one anyway, so we check both.
	for _, fmtStr := range audio.MediaName.Formats {
		pt, err := strconv.Atoi(fmtStr)
		if err != nil {
			continue
		}
		switch pt {
		case 0:
			out.HasPCMU = true
		case 8:
			out.HasPCMA = true
		}
	}
	// Belt-and-braces: also accept dynamic PTs explicitly named via
	// rtpmap. Anything else (Opus etc.) is ignored for Phase A.
	for _, a := range audio.Attributes {
		if a.Key != "rtpmap" {
			continue
		}
		// "rtpmap" value is `<pt> <encoding>/<rate>`.
		fields := strings.SplitN(a.Value, " ", 2)
		if len(fields) != 2 {
			continue
		}
		enc := strings.ToUpper(strings.SplitN(fields[1], "/", 2)[0])
		switch enc {
		case "PCMU":
			out.HasPCMU = true
		case "PCMA":
			out.HasPCMA = true
		}
	}

	return out, nil
}

// directionOf returns the m=audio direction attribute (sendrecv /
// sendonly / recvonly / inactive). Default is sendrecv if no
// directional attribute is present (RFC 4566 §6).
func directionOf(m *sdp.MediaDescription) string {
	for _, a := range m.Attributes {
		switch a.Key {
		case "sendrecv", "sendonly", "recvonly", "inactive":
			return a.Key
		}
	}
	return "sendrecv"
}

// BuildAnswer constructs an SDP answer offering the chosen codec at
// the supplied local RTP endpoint. Always includes PT 101 (RFC 4733
// telephone-event) so the carrier can send DTMF events out-of-band
// instead of inband. The call manager parses them on the receive side
// and forwards as MessageFrames to the worker.
//
// `mediaIP` is the IP the remote should send media to — the bridge's
// public IP / NAT-mapped IP, not necessarily its bind IP. This is set
// from the SIPBRIDGE_MEDIA_IP env var (see config/config.go).
func BuildAnswer(offer *CodecOffer, localRTP *rtp.Session, mediaIP string) ([]byte, rtp.PayloadType, error) {
	pt := rtp.PayloadPCMU
	formats := []string{"0", "101"}
	rtpmaps := []string{"0 PCMU/8000", "101 telephone-event/8000"}
	if !offer.HasPCMU && offer.HasPCMA {
		pt = rtp.PayloadPCMA
		formats = []string{"8", "101"}
		rtpmaps = []string{"8 PCMA/8000", "101 telephone-event/8000"}
	} else if !offer.HasPCMU && !offer.HasPCMA {
		return nil, 0, errors.New("sdp: no acceptable codec in offer (need PCMU or PCMA)")
	}

	port := localRTP.LocalAddr().Port

	// Mirror the offer's direction. If the remote sent sendonly we
	// answer recvonly (etc) per RFC 3264 §6.1. Hold case (sendonly /
	// inactive in the offer) → call manager will inject silence to the
	// WS layer; we don't need to change anything else here.
	answerDir := "sendrecv"
	switch offer.Direction {
	case "sendonly":
		answerDir = "recvonly"
	case "recvonly":
		answerDir = "sendonly"
	case "inactive":
		answerDir = "inactive"
	}

	// Build the SDP by hand — Phase A is so small that the hand-rolled
	// form is shorter and clearer than wiring it through pion/sdp's
	// builder API. If we add ICE / DTLS / SRTP we should switch to the
	// builder.
	lines := []string{
		"v=0",
		fmt.Sprintf("o=- %d %d IN IP4 %s", randSessID(), 1, mediaIP),
		"s=sipbridge",
		fmt.Sprintf("c=IN IP4 %s", mediaIP),
		"t=0 0",
		fmt.Sprintf("m=audio %d RTP/AVP %s", port, strings.Join(formats, " ")),
	}
	for _, rm := range rtpmaps {
		lines = append(lines, "a=rtpmap:"+rm)
	}
	lines = append(lines,
		"a=ptime:20",
		"a=fmtp:101 0-15", // RFC 4733: events 0..15 (keypad)
		"a="+answerDir,
	)

	return []byte(strings.Join(lines, "\r\n") + "\r\n"), pt, nil
}

// BuildOffer constructs the SDP offer we attach to an outbound INVITE.
// We advertise PCMU + PCMA + PT 101 telephone-event (RFC 4733) in
// preference order: mu-law first since most North American carriers
// prefer it; A-law is the European default but every European carrier
// accepts mu-law as a fallback. PT 101 publishes our willingness to
// receive out-of-band DTMF.
func BuildOffer(localRTP *rtp.Session, mediaIP string) []byte {
	port := localRTP.LocalAddr().Port
	lines := []string{
		"v=0",
		fmt.Sprintf("o=- %d %d IN IP4 %s", randSessID(), 1, mediaIP),
		"s=sipbridge",
		fmt.Sprintf("c=IN IP4 %s", mediaIP),
		"t=0 0",
		fmt.Sprintf("m=audio %d RTP/AVP 0 8 101", port),
		"a=rtpmap:0 PCMU/8000",
		"a=rtpmap:8 PCMA/8000",
		"a=rtpmap:101 telephone-event/8000",
		"a=fmtp:101 0-15",
		"a=ptime:20",
		"a=sendrecv",
	}
	return []byte(strings.Join(lines, "\r\n") + "\r\n")
}

// randSessID returns a fresh SDP session-id. The RFC says it should be
// "a string of characters chosen to be unique"; we use a monotonic
// counter seeded at process start, which is unique enough within a
// single bridge instance.
//
// Spelled as a function (not a global) so it can be replaced in tests.
func randSessID() int64 {
	return sessIDCounter.Add(1)
}
