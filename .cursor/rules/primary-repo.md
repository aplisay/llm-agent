# Primary repo guidance (llm-agent)

When making changes to the authoritative runtime code for `llm-agent`, prefer files under:

`/Users/rob/Aplisay/code/llm-agent/`

Treat this path as a vendored/consumer copy (avoid editing unless you explicitly intend to patch the vendor):

`/Users/rob/Aplisay/code/aplisay-b2bua/config-server/vendor/llm-agent/`

If you need to change shared DB logic:
1. Prefer updating the authoritative `llm-agent` tree first.
2. Only propagate to `aplisay-b2bua/.../vendor/llm-agent` if the build/deploy expects the vendored copy.

