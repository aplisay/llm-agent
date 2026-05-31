// SRTP support for the bridge — SDES (RFC 4568) key exchange and the
// foundation pieces for DTLS-SRTP (RFC 5764). The actual DTLS handshake
// lives in dtls.go; this file is about the suite catalogue, crypto
// material wire format, and helpers shared by both paths.
//
// Encryption itself is delegated to pion/srtp/v3 (see EncryptRTP /
// DecryptRTP on Session). We construct one *srtp.Context per direction
// (inbound = peer's master key+salt, outbound = ours) and the Session
// wraps each packet through the matching context.

package rtp

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	dtlsv3 "github.com/pion/dtls/v3"
	srtpv3 "github.com/pion/srtp/v3"
)

// SRTPSuite identifies a key-derivation + cipher + auth-tag profile.
// The wire-form name (SDES ``a=crypto`` parameter) lives in Name.
type SRTPSuite struct {
	// Name is the SDES wire-form name as it appears in ``a=crypto``,
	// e.g. "AES_CM_128_HMAC_SHA1_80".
	Name string
	// PionProfile is the corresponding pion/srtp protection profile.
	// Used to construct an *srtp.Context.
	PionProfile srtpv3.ProtectionProfile
	// DTLSProfile is the DTLS-SRTP IANA profile id (RFC 5764 §4.1.2).
	// Used in DTLS use_srtp extension negotiation.
	DTLSProfile dtlsv3.SRTPProtectionProfile
	// MasterKeyLen + MasterSaltLen are the lengths (bytes) of the
	// master key and master salt for this suite — they go on the
	// wire concatenated and base64-encoded in the SDES ``inline:`` form.
	MasterKeyLen  int
	MasterSaltLen int
}

// Total returns the combined master-key + master-salt length — i.e. how
// many random bytes to generate, and how many decoded bytes a peer's
// ``inline:`` parameter must contain.
func (s SRTPSuite) Total() int { return s.MasterKeyLen + s.MasterSaltLen }

// Catalogue of supported SDES / DTLS-SRTP suites, in preference order.
// AES_CM_128_HMAC_SHA1_80 first — it's the universally-supported SDES
// default — then GCM as a modern alternative for peers that prefer it.
//
// Adding more suites is a matter of extending this slice; the SDP
// emit/parse code uses SuiteByName / SuiteByDTLSProfile to look up.
var SRTPSuites = []SRTPSuite{
	{
		Name:          "AES_CM_128_HMAC_SHA1_80",
		PionProfile:   srtpv3.ProtectionProfileAes128CmHmacSha1_80,
		DTLSProfile:   dtlsv3.SRTP_AES128_CM_HMAC_SHA1_80,
		MasterKeyLen:  16,
		MasterSaltLen: 14,
	},
	{
		Name:          "AEAD_AES_128_GCM",
		PionProfile:   srtpv3.ProtectionProfileAeadAes128Gcm,
		DTLSProfile:   dtlsv3.SRTP_AEAD_AES_128_GCM,
		MasterKeyLen:  16,
		MasterSaltLen: 12,
	},
}

// SuiteByName returns the catalogue entry matching the SDES wire-form
// suite name, or false if we don't support it.
func SuiteByName(name string) (SRTPSuite, bool) {
	for _, s := range SRTPSuites {
		if strings.EqualFold(s.Name, name) {
			return s, true
		}
	}
	return SRTPSuite{}, false
}

// SuiteByDTLSProfile returns the catalogue entry matching the DTLS-SRTP
// protection profile that the DTLS handshake negotiated, or false if
// the profile isn't in our supported set.
func SuiteByDTLSProfile(p dtlsv3.SRTPProtectionProfile) (SRTPSuite, bool) {
	for _, s := range SRTPSuites {
		if s.DTLSProfile == p {
			return s, true
		}
	}
	return SRTPSuite{}, false
}

// CryptoMaterial is a master key + master salt pair, tagged with the
// suite it belongs to. The SDES ``inline:`` parameter encodes this as
// base64(key || salt); DTLS-SRTP derives one of these per direction
// from the keying-material export.
type CryptoMaterial struct {
	Suite      SRTPSuite
	MasterKey  []byte
	MasterSalt []byte
}

// Generate mints fresh random key + salt for the given suite. Used on
// the SDES outbound path — we generate our half, send it in our SDP
// answer / offer, and use it for our outbound *srtp.Context.
func Generate(suite SRTPSuite) (CryptoMaterial, error) {
	key := make([]byte, suite.MasterKeyLen)
	if _, err := rand.Read(key); err != nil {
		return CryptoMaterial{}, fmt.Errorf("srtp: random master key: %w", err)
	}
	salt := make([]byte, suite.MasterSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return CryptoMaterial{}, fmt.Errorf("srtp: random master salt: %w", err)
	}
	return CryptoMaterial{Suite: suite, MasterKey: key, MasterSalt: salt}, nil
}

// EncodeInline returns the base64(key||salt) form for the SDES
// ``a=crypto:N <suite> inline:<inline>`` parameter.
func (m CryptoMaterial) EncodeInline() string {
	buf := make([]byte, 0, m.Suite.Total())
	buf = append(buf, m.MasterKey...)
	buf = append(buf, m.MasterSalt...)
	return base64.StdEncoding.EncodeToString(buf)
}

// DecodeInline parses an SDES ``inline:`` parameter back into a
// CryptoMaterial. The suite is needed because the split between key
// and salt is suite-dependent.
//
// RFC 4568 allows additional ``inline:`` parameters after the key
// material (lifetime, mki) separated by ``|``; we accept them but
// discard them — they're optional and meaningful only for re-key,
// which we defer to a later phase.
func DecodeInline(suite SRTPSuite, inline string) (CryptoMaterial, error) {
	// Strip optional lifetime / mki tail.
	if i := strings.IndexByte(inline, '|'); i >= 0 {
		inline = inline[:i]
	}
	raw, err := base64.StdEncoding.DecodeString(inline)
	if err != nil {
		return CryptoMaterial{}, fmt.Errorf("srtp: base64-decode inline: %w", err)
	}
	if len(raw) != suite.Total() {
		return CryptoMaterial{}, fmt.Errorf(
			"srtp: %s expects %d bytes (key %d + salt %d) but inline decoded to %d",
			suite.Name, suite.Total(), suite.MasterKeyLen, suite.MasterSaltLen, len(raw),
		)
	}
	return CryptoMaterial{
		Suite:      suite,
		MasterKey:  raw[:suite.MasterKeyLen],
		MasterSalt: raw[suite.MasterKeyLen:],
	}, nil
}

// Context builds a pion *srtp.Context for use on a Session's read or
// write path. One context per direction — pion contexts are not
// bidirectional.
func (m CryptoMaterial) Context() (*srtpv3.Context, error) {
	if len(m.MasterKey) != m.Suite.MasterKeyLen || len(m.MasterSalt) != m.Suite.MasterSaltLen {
		return nil, errors.New("srtp: crypto material size doesn't match suite")
	}
	return srtpv3.CreateContext(m.MasterKey, m.MasterSalt, m.Suite.PionProfile)
}
