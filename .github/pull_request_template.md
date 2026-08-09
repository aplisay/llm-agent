<!-- One issue → one focused PR. Base = `next` (never `main` — main is release-only/tagged).
     See docs/CONTEXT.md (Definition of Done + coordination / hot files). -->

Closes #

## What changed
<!-- The change, in 1–3 bullets. Keep the diff small and single-purpose. -->
-

## Why
<!-- The motivation / the issue's intent. -->

## Lane(s) / files touched
<!-- Match the issue's lane. Call out any high-contention shared files
     (index.mjs, api/api-doc.yaml, lib/ws-handler.js, lib/handlers/*, lib/database.js,
     lib/models/index.js, package.json) so the merge-train sequences this correctly. -->

## How verified
<!-- Paste the result of the repo's verify check (see docs/CONTEXT.md → Definition of Done). -->
```

```

## Checklist
- [ ] The repo's configured verify check passes locally
- [ ] No temporary scaffolding/debug code left behind
- [ ] Public API changes are reflected in `api/api-doc.yaml`
- [ ] Follows the conventions in docs/CONTEXT.md
- [ ] Rebased on the latest `next`
