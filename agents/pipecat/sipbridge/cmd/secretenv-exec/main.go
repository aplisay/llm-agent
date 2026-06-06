// Command secretenv-exec decrypts SECRETENV_BUNDLE into the environment and then
// execs the wrapped command. It exists for containers that can't decrypt the
// bundle natively — FreeSWITCH and the third-party Voiceblender image — so they
// can be fed the same single SECRETENV_KEY + SECRETENV_BUNDLE secret as the
// worker and sipbridge. Secrets live only in this process's memory and the
// exec'd child's environment; nothing is written to disk.
//
// Usage:
//
//	secretenv-exec <command> [args...]
//
// Example (Kubernetes container command):
//
//	["/etc/node-meta/secretenv-exec", "/usr/bin/entrypoint.sh"]
package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"github.com/aplisay/llm-agent/agents/pipecat/sipbridge/internal/secretenv"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: secretenv-exec <command> [args...]")
		os.Exit(2)
	}

	// Decrypt into our own environment; the exec'd child inherits it. A bad or
	// absent bundle is non-fatal — we still exec so a container whose command
	// can run without those vars (or self-decrypts) isn't bricked.
	if err := secretenv.Load(); err != nil {
		fmt.Fprintf(os.Stderr, "secretenv-exec: %v (continuing)\n", err)
	}

	bin, err := exec.LookPath(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "secretenv-exec: cannot find %q: %v\n", os.Args[1], err)
		os.Exit(127)
	}

	// Replace this process so signals/exit codes pass straight through to the
	// wrapped command (correct PID 1 behaviour in a container).
	if err := syscall.Exec(bin, os.Args[1:], os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "secretenv-exec: exec %q: %v\n", bin, err)
		os.Exit(126)
	}
}
