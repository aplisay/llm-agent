// Package secretenv decrypts a SECRETENV_BUNDLE into the process environment.
//
// Wire-compatible with github.com/rjp44/secretenv (the Node package the
// esl-poller sidecar uses), so a single SECRETENV_KEY + SECRETENV_BUNDLE pair —
// e.g. one Kubernetes Secret — can carry every credential the bridge needs:
//
//	key       = HMAC-SHA256(key="secretenv", msg=SECRETENV_KEY)   // 32 bytes
//	bundle    = "<iv_hex>:<base64(ciphertext)>"                   // AES-256-CBC, PKCS7
//	plaintext = a JSON object {"VAR": "value", ...}
//
// Call Load once, before reading config, so secrets are decrypted straight into
// the environment and never written to disk.
package secretenv

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

func deriveKey(secretKey string) []byte {
	m := hmac.New(sha256.New, []byte("secretenv"))
	m.Write([]byte(secretKey))
	return m.Sum(nil)
}

// Decrypt returns the variables in bundle, decrypted with secretKey. Exported
// so the exec-wrapper and tests can reuse it.
func Decrypt(bundle, secretKey string) (map[string]string, error) {
	ivHex, ctB64, found := strings.Cut(bundle, ":")
	if !found {
		return nil, fmt.Errorf("secretenv: bundle not in '<iv>:<ciphertext>' form")
	}
	iv, err := hex.DecodeString(ivHex)
	if err != nil {
		return nil, fmt.Errorf("secretenv: bad iv: %w", err)
	}
	ct, err := base64.StdEncoding.DecodeString(ctB64)
	if err != nil {
		return nil, fmt.Errorf("secretenv: bad ciphertext base64: %w", err)
	}
	block, err := aes.NewCipher(deriveKey(secretKey))
	if err != nil {
		return nil, err
	}
	bs := block.BlockSize()
	if len(iv) != bs {
		return nil, fmt.Errorf("secretenv: iv length %d, want %d", len(iv), bs)
	}
	if len(ct) == 0 || len(ct)%bs != 0 {
		return nil, fmt.Errorf("secretenv: ciphertext not block-aligned")
	}
	pt := make([]byte, len(ct))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(pt, ct)
	pt, err = pkcs7Unpad(pt, bs)
	if err != nil {
		return nil, err
	}

	// The plaintext is a JSON object whose values are usually strings but may
	// be numbers/bools (dotenv parses everything as strings, but be lenient).
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(pt, &raw); err != nil {
		return nil, fmt.Errorf("secretenv: bundle JSON: %w", err)
	}
	out := make(map[string]string, len(raw))
	for k, v := range raw {
		out[k] = jsonToString(v)
	}
	return out, nil
}

func pkcs7Unpad(b []byte, blockSize int) ([]byte, error) {
	n := len(b)
	if n == 0 {
		return nil, fmt.Errorf("secretenv: empty plaintext")
	}
	pad := int(b[n-1])
	if pad == 0 || pad > blockSize || pad > n {
		return nil, fmt.Errorf("secretenv: invalid PKCS7 padding")
	}
	for _, c := range b[n-pad:] {
		if int(c) != pad {
			return nil, fmt.Errorf("secretenv: invalid PKCS7 padding")
		}
	}
	return b[:n-pad], nil
}

func jsonToString(v json.RawMessage) string {
	var s string
	if err := json.Unmarshal(v, &s); err == nil {
		return s
	}
	// Non-string scalar (number/bool/null): use the raw JSON text, with
	// surrounding quotes already absent for those types. null -> "".
	t := strings.TrimSpace(string(v))
	if t == "null" {
		return ""
	}
	return t
}

// Load decrypts SECRETENV_BUNDLE into the environment (overriding any existing
// values, matching the Node package's Object.assign semantics). It is a no-op
// when SECRETENV_KEY or SECRETENV_BUNDLE is unset. A malformed bundle returns an
// error the caller may log without necessarily aborting startup.
func Load() error {
	key := os.Getenv("SECRETENV_KEY")
	bundle := os.Getenv("SECRETENV_BUNDLE")
	if key == "" || bundle == "" {
		return nil
	}
	vars, err := Decrypt(bundle, key)
	if err != nil {
		return err
	}
	for k, v := range vars {
		if err := os.Setenv(k, v); err != nil {
			return fmt.Errorf("secretenv: setenv %s: %w", k, err)
		}
	}
	return nil
}

// Count reports how many variables a bundle holds, for log messages. Returns 0
// on any error.
func Count(bundle, secretKey string) int {
	vars, err := Decrypt(bundle, secretKey)
	if err != nil {
		return 0
	}
	return len(vars)
}
