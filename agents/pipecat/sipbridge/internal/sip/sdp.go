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
	HasPCMU    bool
	HasPCMA    bool
	RemoteIP   string
	RemotePort int
	// Direction of the m=audio line (sendrecv / sendonly / recvonly /
	// inactive). Hold (a=sendonly / a=inactive) is signalled this way
	// — we honour it on the audio bridge but don't tear down the call.
	Direction string

	// MediaProfile is the m=audio profile token, joined with '/' — one of
	// "RTP/AVP", "RTP/SAVP", "UDP/TLS/RTP/SAVP", "RTP/SAVPF", etc.
	// Tells us which key-exchange path the peer offered: plain, SDES, or
	// DTLS-SRTP.
	MediaProfile string

	// CryptoOffers carries the parsed ``a=crypto`` attributes when the
	// peer offered SDES (MediaProfile is RTP/SAVP or RTP/SAVPF). Each
	// entry preserves the order the peer sent so we can honour their
	// preference. Empty for non-SDES offers.
	CryptoOffers []CryptoAttr

	// Fingerprint is the parsed ``a=fingerprint:<algo> <hex>`` for
	// DTLS-SRTP. Used to verify the peer's cert during the DTLS
	// handshake. Empty for non-DTLS offers.
	Fingerprint Fingerprint

	// Setup is the parsed ``a=setup:<role>`` for DTLS-SRTP — one of
	// "active", "passive", "actpass", "holdconn" (RFC 4145). When the
	// peer offers "actpass" we pick "passive" (server-side handshake);
	// when they offer "active" we pick "passive"; when they offer
	// "passive" we pick "active". Empty for non-DTLS offers.
	Setup string
}

// CryptoAttr is one parsed ``a=crypto:<tag> <suite> inline:<inline> [params...]``
// attribute. Tag is the peer's identifier for this offer; we echo it
// back in our answer so they know which offer we accepted.
//
// Inline is the base64(masterKey||masterSalt) form; pass it through
// ``rtp.DecodeInline(suite, inline)`` once you know the suite — the
// suite name lives in Suite.
type CryptoAttr struct {
	Tag    int
	Suite  string // SDES suite name, e.g. "AES_CM_128_HMAC_SHA1_80"
	Inline string // raw base64(key||salt), tail params already stripped
	// Params is the trailing optional ``lifetime|mki:length`` etc, kept
	// for completeness but not interpreted in v1 (no re-key support).
	Params string
}

// Fingerprint is a parsed ``a=fingerprint:<algorithm> <hex>``. Algorithm
// is lowercased ("sha-256", "sha-1", …); Hex is the colon-separated
// hex form on the wire (matching ``openssl x509 -fingerprint``).
type Fingerprint struct {
	Algorithm string
	Hex       string
}

// IsZero reports whether the fingerprint is unset (no a=fingerprint
// attribute seen).
func (f Fingerprint) IsZero() bool { return f.Algorithm == "" }

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
		Direction:    directionOf(audio),
		MediaProfile: strings.Join(audio.MediaName.Protos, "/"),
	}

	// Walk session-level a=fingerprint / a=setup first so the
	// media-level (if any) can override below per RFC 8842.
	for _, a := range sess.Attributes {
		switch a.Key {
		case "fingerprint":
			out.Fingerprint = parseFingerprint(a.Value)
		case "setup":
			out.Setup = strings.ToLower(strings.TrimSpace(a.Value))
		}
	}
	// Media-level attributes for the audio stream — these win over
	// session-level (and are where carriers usually put crypto attrs).
	for _, a := range audio.Attributes {
		switch a.Key {
		case "crypto":
			if ca, ok := parseCryptoAttr(a.Value); ok {
				out.CryptoOffers = append(out.CryptoOffers, ca)
			}
		case "fingerprint":
			out.Fingerprint = parseFingerprint(a.Value)
		case "setup":
			out.Setup = strings.ToLower(strings.TrimSpace(a.Value))
		}
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

// parseCryptoAttr decodes an SDES ``a=crypto`` value into a CryptoAttr.
// Returns ``false`` on malformed input — we silently skip rather than
// fail the whole parse, since the peer may offer several crypto lines
// and we only need to recognise one we can use.
//
// Wire format: ``<tag> <suite> inline:<key>[|<lifetime>[|<mki:length>]] [more params...]``
//
//	1 AES_CM_128_HMAC_SHA1_80 inline:WVNfX19zZW1jdGw|2^20|1:4
func parseCryptoAttr(value string) (CryptoAttr, bool) {
	fields := strings.Fields(value)
	if len(fields) < 3 {
		return CryptoAttr{}, false
	}
	tag, err := strconv.Atoi(fields[0])
	if err != nil {
		return CryptoAttr{}, false
	}
	suite := fields[1]
	// Find the inline: parameter. It's typically the first key=value
	// pair after the suite, but per RFC 4568 other key=value params can
	// precede it (key-method=other things), so we scan all post-suite
	// fields rather than assume position.
	var inlineRaw string
	var paramsTail []string
	for _, f := range fields[2:] {
		if rest, ok := strings.CutPrefix(f, "inline:"); ok {
			inlineRaw = rest
			continue
		}
		paramsTail = append(paramsTail, f)
	}
	if inlineRaw == "" {
		return CryptoAttr{}, false
	}
	// Split off optional ``|lifetime|mki:length`` from the inline value;
	// keep the head as base64 of key||salt, the tail goes in Params.
	var inlineParams string
	if i := strings.IndexByte(inlineRaw, '|'); i >= 0 {
		inlineParams = inlineRaw[i+1:]
		inlineRaw = inlineRaw[:i]
	}
	allParams := inlineParams
	if len(paramsTail) > 0 {
		if allParams != "" {
			allParams += " "
		}
		allParams += strings.Join(paramsTail, " ")
	}
	return CryptoAttr{
		Tag:    tag,
		Suite:  suite,
		Inline: inlineRaw,
		Params: allParams,
	}, true
}

// parseFingerprint decodes ``a=fingerprint:<algorithm> <hex>``.
// Algorithm is lower-cased so callers can compare without surprise;
// hex is preserved in the colon-separated upper-case form most CAs +
// openssl emit.
func parseFingerprint(value string) Fingerprint {
	fields := strings.Fields(value)
	if len(fields) < 2 {
		return Fingerprint{}
	}
	return Fingerprint{
		Algorithm: strings.ToLower(fields[0]),
		Hex:       strings.ToUpper(fields[1]),
	}
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

// EncryptionParams describes the encryption choice for an outgoing SDP
// answer or offer. The caller (typically internal/call/manager.go)
// composes this after deciding which key-exchange mode it can satisfy
// based on what the peer offered and the bridge's policy. Zero value
// means plaintext RTP/AVP — backwards-compatible with the original
// Phase A behaviour.
type EncryptionParams struct {
	// Profile is the SDP media profile token, joined with '/'. Common
	// values: "RTP/AVP" (plaintext), "RTP/SAVP" (SDES), "RTP/SAVPF"
	// (SDES with feedback), "UDP/TLS/RTP/SAVP" (DTLS-SRTP). Empty
	// defaults to "RTP/AVP".
	Profile string

	// CryptoLines holds the post-prefix value(s) of ``a=crypto:`` lines
	// for SDES — each entry is one line, e.g.
	// "1 AES_CM_128_HMAC_SHA1_80 inline:abc...". An SDP answer carries
	// exactly one (the suite we accepted); an SDP offer can carry many
	// (one per suite we'd be willing to use, in preference order). Set
	// when Profile is "RTP/SAVP" or "RTP/SAVPF"; nil otherwise.
	CryptoLines []string

	// Fingerprint is the post-prefix value of ``a=fingerprint:`` for
	// DTLS-SRTP — e.g. "sha-256 AB:CD:...". Set when Profile is
	// "UDP/TLS/RTP/SAVP"; empty otherwise.
	Fingerprint string

	// SetupRole is the ``a=setup:<role>`` value for DTLS-SRTP — one of
	// "active", "passive", "actpass". RFC 5763 §5: an answer MUST NOT
	// use "actpass"; pick "passive" if the offer is "actpass" or
	// "active", and "active" if the offer is "passive". Empty for
	// non-DTLS answers.
	SetupRole string
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
//
// `enc` selects the media profile (plain / SDES / DTLS-SRTP) and the
// matching SDP attributes. Pass zero value for plaintext.
func BuildAnswer(offer *CodecOffer, localRTP *rtp.Session, mediaIP string, enc EncryptionParams) ([]byte, rtp.PayloadType, error) {
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

	profile := enc.Profile
	if profile == "" {
		profile = "RTP/AVP"
	}

	// Build the SDP by hand — the structure is small enough that
	// hand-rolled is shorter and clearer than wiring through pion/sdp's
	// builder.
	lines := []string{
		"v=0",
		fmt.Sprintf("o=- %d %d IN IP4 %s", randSessID(), 1, mediaIP),
		"s=sipbridge",
		fmt.Sprintf("c=IN IP4 %s", mediaIP),
		"t=0 0",
		fmt.Sprintf("m=audio %d %s %s", port, profile, strings.Join(formats, " ")),
	}
	for _, rm := range rtpmaps {
		lines = append(lines, "a=rtpmap:"+rm)
	}
	// Encryption-specific attributes go right after the codec rtpmaps,
	// before ptime/fmtp/direction. SBC parsers don't care about order
	// here but this matches how most carriers emit their offers.
	for _, cl := range enc.CryptoLines {
		lines = append(lines, "a=crypto:"+cl)
	}
	if enc.Fingerprint != "" {
		lines = append(lines, "a=fingerprint:"+enc.Fingerprint)
	}
	if enc.SetupRole != "" {
		lines = append(lines, "a=setup:"+enc.SetupRole)
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
//
// ``enc`` selects the media profile (plain / SDES / DTLS-SRTP) and the
// matching SDP attributes — for an outbound originate we get to choose
// what we offer. Pass the zero value for plaintext.
func BuildOffer(localRTP *rtp.Session, mediaIP string, enc EncryptionParams) []byte {
	port := localRTP.LocalAddr().Port
	profile := enc.Profile
	if profile == "" {
		profile = "RTP/AVP"
	}
	lines := []string{
		"v=0",
		fmt.Sprintf("o=- %d %d IN IP4 %s", randSessID(), 1, mediaIP),
		"s=sipbridge",
		fmt.Sprintf("c=IN IP4 %s", mediaIP),
		"t=0 0",
		fmt.Sprintf("m=audio %d %s 0 8 101", port, profile),
		"a=rtpmap:0 PCMU/8000",
		"a=rtpmap:8 PCMA/8000",
		"a=rtpmap:101 telephone-event/8000",
	}
	for _, cl := range enc.CryptoLines {
		lines = append(lines, "a=crypto:"+cl)
	}
	if enc.Fingerprint != "" {
		lines = append(lines, "a=fingerprint:"+enc.Fingerprint)
	}
	if enc.SetupRole != "" {
		lines = append(lines, "a=setup:"+enc.SetupRole)
	}
	lines = append(lines,
		"a=fmtp:101 0-15",
		"a=ptime:20",
		"a=sendrecv",
	)
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
