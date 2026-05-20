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
)

type Config struct {
	// SIP signalling.
	SIPSignalIP   string // advertised in Contact / Via — public-facing IP
	SIPSignalPort int    // default 5060 (UDP)
	SIPBindIP     string // bind address for the UDP listener — default = SIPSignalIP

	// TLS / SIPS (Phase G). When enabled the bridge listens on
	// `TLSSignalPort` over TCP+TLS in addition to the UDP listener.
	// Carriers / B2BUAs targeting SIPS use the TLS port; the UDP
	// listener stays up for any non-TLS peer.
	TLSEnabled    bool   // true if both TLSCertFile and TLSKeyFile are set
	TLSSignalPort int    // default 5061
	TLSCertFile   string // PEM-encoded certificate path
	TLSKeyFile    string // PEM-encoded private key path

	// RTP media.
	MediaIP     string // public-facing media IP, advertised in SDP c=/m=
	MediaBindIP string // local bind IP for RTP sockets — default = MediaIP
	RTPPortMin  int    // default 10000
	RTPPortMax  int    // default 20000

	// Pipecat worker WebSocket base URL — we append /sipbridge/agent/{session_id}.
	WorkerWSBase string

	// REST control API bind address.
	APIBindAddr string // default :8080

	// Shared bearer for the REST API. Empty disables auth (dev only).
	APIBearerToken string

	// Logging.
	LogLevel string // default "info"
}

// Load reads the environment and returns a fully-populated Config, or
// an error if a required value is missing.
func Load() (*Config, error) {
	cfg := &Config{
		SIPSignalIP:    env("SIPBRIDGE_SIP_SIGNAL_IP", ""),
		SIPSignalPort:  envInt("SIPBRIDGE_SIP_SIGNAL_PORT", 5060),
		SIPBindIP:      env("SIPBRIDGE_SIP_BIND_IP", ""),
		TLSSignalPort:  envInt("SIPBRIDGE_SIP_TLS_PORT", 5061),
		TLSCertFile:    env("SIPBRIDGE_TLS_CERT_FILE", ""),
		TLSKeyFile:     env("SIPBRIDGE_TLS_KEY_FILE", ""),
		MediaIP:        env("SIPBRIDGE_MEDIA_IP", ""),
		MediaBindIP:    env("SIPBRIDGE_MEDIA_BIND_IP", ""),
		RTPPortMin:     envInt("SIPBRIDGE_RTP_PORT_MIN", 10000),
		RTPPortMax:     envInt("SIPBRIDGE_RTP_PORT_MAX", 20000),
		WorkerWSBase:   env("SIPBRIDGE_WORKER_WS_BASE", "ws://pipecat-worker:8082"),
		APIBindAddr:    env("SIPBRIDGE_API_BIND_ADDR", ":8090"),
		APIBearerToken: env("SIPBRIDGE_API_TOKEN", ""),
		LogLevel:       env("SIPBRIDGE_LOG_LEVEL", "info"),
	}
	cfg.TLSEnabled = cfg.TLSCertFile != "" && cfg.TLSKeyFile != ""
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
