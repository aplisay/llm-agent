// Package config loads sipbridge's runtime settings from environment
// variables.
//
// Every knob is overridable for dev / staging; sensible defaults make
// the canonical compose deploy work without any explicit configuration.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	// SIP signalling.
	SIPSignalIP   string // advertised in Contact / Via — public-facing IP
	SIPSignalPort int    // default 5060 (UDP)
	SIPBindIP     string // bind address for the UDP listener — default = SIPSignalIP
	// UDPDisabled skips the UDP listener entirely. Useful when running
	// behind Docker Desktop on macOS / Windows, where inbound UDP source
	// addresses are NAT-mangled to loopback (``[::1]``) and responses
	// never reach the real peer. TLS sidesteps this because TCP keeps
	// the bidirectional connection state independent of the apparent
	// source IP. When UDPDisabled is true, the operator MUST configure
	// the upstream B2BUA / carrier to use ``transport=tls`` on the TLS
	// port; any UDP INVITEs will simply be unanswered.
	UDPDisabled bool

	// TLS / SIPS (Phase G). The bridge listens on ``TLSSignalPort`` over
	// TCP+TLS. Carriers / B2BUAs targeting SIPS use the TLS port; if
	// UDPDisabled is false, the UDP listener remains up in parallel for
	// any non-TLS peer.
	//
	// If both TLSCertFile and TLSKeyFile are set the bridge loads that
	// keypair. Otherwise — and unless TLSAutoSelfSigned is explicitly
	// disabled — it mints an ephemeral self-signed cert at startup
	// covering SIPSignalIP and "sipbridge". This makes TLS-only
	// deployments work out of the box with an SBC configured to skip
	// cert validation; for production you should mount a real cert.
	TLSEnabled        bool   // true if either a cert pair is loaded or self-signed is in play
	TLSSignalPort     int    // default 5061
	TLSCertFile       string // PEM-encoded certificate path (optional if TLSAutoSelfSigned)
	TLSKeyFile        string // PEM-encoded private key path (optional if TLSAutoSelfSigned)
	TLSAutoSelfSigned bool   // generate ephemeral self-signed cert when no cert file is set

	// RTP media.
	MediaIP     string // public-facing media IP, advertised in SDP c=/m=
	MediaBindIP string // local bind IP for RTP sockets — default = MediaIP
	RTPPortMin  int    // default 10000
	RTPPortMax  int    // default 20000
	// RTPTimeoutSeconds: tear the call down (BYE upstream + close
	// worker WS) after this many seconds with no inbound RTP. Catches
	// Twilio's Elastic SIP Trunk "silent hangup" behaviour (no BYE,
	// media just stops) and any other peer that drops media without
	// signalling. 0 disables. Default 10 — long enough to ride out
	// brief network blips (typical packet-loss bursts are 1–3s) but
	// short enough that the bot doesn't keep talking into the void.
	RTPTimeoutSeconds int
	// RTPSilenceFill: transmit a frame of codec silence every 20 ms while
	// the bot has nothing to say, rather than suppressing the packet and
	// carrying the pause as an RTP timestamp jump. On (the default) is
	// ordinary SIP UA behaviour — media flows for the life of the call
	// whoever is talking — and it is what keeps the PEER's media watchdog
	// (RTPTimeoutSeconds above, at their end) and any carrier NAT pinhole
	// alive through a silent stretch. Set false to restore suppression.
	RTPSilenceFill bool

	// SRTP encrypted-media policy.
	//
	// - SRTPEnabled: accept encrypted offers (SDES + DTLS-SRTP) when the
	//   peer asks for them, fall back to plaintext otherwise. Default
	//   true; set false only to force plaintext (debugging).
	// - SRTPRequired: refuse plaintext-only offers with SIP 488 Not
	//   Acceptable Here. Use this when the bridge sits behind TLS
	//   signalling and any plaintext peer is a misconfiguration.
	//   Implies SRTPEnabled.
	// - SRTPDTLSEnabled: opt into DTLS-SRTP in addition to SDES.
	//   Default true; both are supported when the peer's SDP indicates
	//   the matching profile. Disabling it forces SDES-only (useful for
	//   peers with broken DTLS-SRTP implementations).
	SRTPEnabled     bool
	SRTPRequired    bool
	SRTPDTLSEnabled bool
	// SRTPOutbound: offer SDES SRTP on outbound INVITEs (best-effort
	// — peer that doesn't support it will reject with 488 and the
	// outbound originate fails). Set to false to fall back to
	// plaintext outbound offers, e.g. for trunks known not to support
	// SRTP. Has no effect when SRTPEnabled is false.
	SRTPOutbound bool

	// Outbound SIP digest credentials. Presented when an outbound INVITE is
	// challenged (401/407) by the upstream SBC — i.e. the "outbound trunk"
	// auth, the analogue of LiveKit's createSipOutboundTrunk
	// authUsername/authPassword. Empty → no auth (peer must accept
	// unauthenticated, e.g. IP-allowlisted SBC). Named PIPECAT_SIP_* to line
	// up with the platform's PIPECAT_SIP_OUTBOUND route setting.
	SIPAuthUsername string
	SIPAuthPassword string

	// SIPFromDomain is the host presented in the From of outbound INVITEs (the
	// From user is the per-call CLI). The upstream SBC gates outbound-trunk
	// routing on this domain, so it must match a handler domain the SBC
	// recognises (e.g. the pipecat handler domain / PIPECAT_HANDLER_DOMAIN on
	// the SBC). Empty → sipgo's default From (only works for SBCs that
	// authenticate purely by source IP).
	SIPFromDomain string

	// Pipecat worker WebSocket base URL — we append /sipbridge/agent/{session_id}.
	WorkerWSBase string

	// REST control API bind address.
	APIBindAddr string // default :8080

	// Shared bearer for the REST API. Empty disables auth (dev only).
	APIBearerToken string

	// Logging.
	LogLevel string // default "info"
	// SIPTraceEnabled: log every SIP message that crosses the wire at
	// INFO with full headers + body. Heavy but invaluable for debugging
	// dialog-level issues (missing BYE, weird carrier SDP, etc.). Off
	// by default; enable in dev compose.
	SIPTraceEnabled bool
}

// Load reads the environment and returns a fully-populated Config, or
// an error if a required value is missing.
func Load() (*Config, error) {
	cfg := &Config{
		SIPSignalIP:    env("SIPBRIDGE_SIP_SIGNAL_IP", ""),
		SIPSignalPort:  envInt("SIPBRIDGE_SIP_SIGNAL_PORT", 5060),
		SIPBindIP:      env("SIPBRIDGE_SIP_BIND_IP", ""),
		UDPDisabled:    envBool("SIPBRIDGE_SIP_UDP_DISABLED", false),
		TLSSignalPort:     envInt("SIPBRIDGE_SIP_TLS_PORT", 5061),
		TLSCertFile:       env("SIPBRIDGE_TLS_CERT_FILE", ""),
		TLSKeyFile:        env("SIPBRIDGE_TLS_KEY_FILE", ""),
		TLSAutoSelfSigned: envBool("SIPBRIDGE_TLS_AUTO_SELFSIGNED", true),
		SRTPEnabled:       envBool("SIPBRIDGE_SRTP_ENABLED", true),
		SRTPRequired:      envBool("SIPBRIDGE_SRTP_REQUIRED", false),
		SRTPDTLSEnabled:   envBool("SIPBRIDGE_SRTP_DTLS_ENABLED", true),
		SRTPOutbound:      envBool("SIPBRIDGE_SRTP_OUTBOUND", true),
		SIPAuthUsername:   env("PIPECAT_SIP_USERNAME", ""),
		SIPAuthPassword:   env("PIPECAT_SIP_PASSWORD", ""),
		SIPFromDomain:     env("PIPECAT_SIP_FROM_DOMAIN", ""),
		MediaIP:        env("SIPBRIDGE_MEDIA_IP", ""),
		MediaBindIP:    env("SIPBRIDGE_MEDIA_BIND_IP", ""),
		RTPPortMin:        envInt("SIPBRIDGE_RTP_PORT_MIN", 10000),
		RTPPortMax:        envInt("SIPBRIDGE_RTP_PORT_MAX", 20000),
		RTPTimeoutSeconds: envInt("SIPBRIDGE_RTP_TIMEOUT_SECONDS", 10),
		RTPSilenceFill:    envBool("SIPBRIDGE_RTP_SILENCE_FILL", true),
		WorkerWSBase:   env("SIPBRIDGE_WORKER_WS_BASE", "ws://pipecat-worker:8082"),
		APIBindAddr:    env("SIPBRIDGE_API_BIND_ADDR", ":8090"),
		APIBearerToken: env("SIPBRIDGE_API_TOKEN", ""),
		LogLevel:        env("SIPBRIDGE_LOG_LEVEL", "info"),
		SIPTraceEnabled: envBool("SIPBRIDGE_SIP_TRACE", false),
	}
	// TLS is on if either a real cert pair is provided OR we're
	// allowed to auto-generate a self-signed one. Disable both knobs
	// to turn TLS off entirely.
	cfg.TLSEnabled = (cfg.TLSCertFile != "" && cfg.TLSKeyFile != "") || cfg.TLSAutoSelfSigned
	// SIPSignalIP / MediaIP must be set explicitly — there's no safe
	// default ("127.0.0.1" works for local dev but silently fails when
	// any remote peer can't reach 127.0.0.1, so refuse to start).
	if cfg.SIPSignalIP == "" {
		return nil, fmt.Errorf("config: SIPBRIDGE_SIP_SIGNAL_IP not set")
	}
	if cfg.MediaIP == "" {
		// Conventional default: SDP media IP matches SIP signalling IP.
		cfg.MediaIP = cfg.SIPSignalIP
	}
	if cfg.SIPBindIP == "" {
		cfg.SIPBindIP = cfg.SIPSignalIP
	}
	if cfg.MediaBindIP == "" {
		cfg.MediaBindIP = cfg.MediaIP
	}
	if cfg.RTPPortMin >= cfg.RTPPortMax {
		return nil, fmt.Errorf("config: RTP_PORT_MIN(%d) >= RTP_PORT_MAX(%d)",
			cfg.RTPPortMin, cfg.RTPPortMax)
	}
	// Refuse to start with no SIP listener at all — silently doing
	// nothing on the SIP port is a foot-gun.
	if cfg.UDPDisabled && !cfg.TLSEnabled {
		return nil, fmt.Errorf("config: SIPBRIDGE_SIP_UDP_DISABLED is set but TLS is not configured (set SIPBRIDGE_TLS_CERT_FILE and SIPBRIDGE_TLS_KEY_FILE, or re-enable UDP)")
	}
	// SRTPRequired without SRTPEnabled is a misconfiguration that would
	// silently never accept any call. Refuse to start.
	if cfg.SRTPRequired && !cfg.SRTPEnabled {
		return nil, fmt.Errorf("config: SIPBRIDGE_SRTP_REQUIRED is set but SIPBRIDGE_SRTP_ENABLED=0; either enable SRTP or relax the requirement")
	}
	return cfg, nil
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	v, ok := os.LookupEnv(key)
	if !ok {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func envBool(key string, def bool) bool {
	v, ok := os.LookupEnv(key)
	if !ok {
		return def
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off", "":
		return false
	}
	return def
}
