---
description: Take the open `action` issues all the way to merged on the integration branch (parallel-issues → adversarial review gate → merge-train), using the central ship-kit pinned at runtime.
argument-hint: "[optional JSON args, e.g. {\"apply\":false} or [29,30]]"
---

Run the full **issue → PR → merge** pipeline for THIS repo, using the *generalised* workflow scripts from the central **ship-kit** repo (fetched fresh at run time, so every project always runs the latest tuned logic). All project specifics come from this repo's `.claude/ship.config.json`.

Do this:

1. **Load this repo's config.** It must exist; if not, STOP and tell the user to run the ship-kit install (see ship-kit `install.md`).
   ```bash
   set -e
   git fetch origin -q || true
   CFG=.claude/ship.config.json
   [ -f "$CFG" ] || { echo "No .claude/ship.config.json — run the ship-kit install first."; exit 1; }
   rd(){ node -e "console.log((JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[process.argv[2]])||process.argv[3]||'')" "$1" "$2" "$3"; }
   BASE=$(rd "$CFG" base next)
   # Prefer the integration-branch copy of the config so a stale feature branch still
   # ships with the canonical settings (falls back to the local file).
   if git show "origin/$BASE:.claude/ship.config.json" > /tmp/ship.config.json 2>/dev/null; then CFG=/tmp/ship.config.json; fi
   KITREPO=$(rd "$CFG" kitRepo aplisay/ship-kit)
   KITREF=$(rd "$CFG" kitRef main)
   echo "config=$CFG base=$BASE kit=$KITREPO@$KITREF"
   ```
   (Then read the resolved `$CFG` file with the Read tool — that JSON object is the `cfg` you pass as workflow args in step 3.)

2. **Materialise the kit.** Clone the central kit at its pinned ref into a scratch dir (private repo → use `gh` for auth):
   ```bash
   DIR=$(mktemp -d)
   gh repo clone "$KITREPO" "$DIR" -- --depth 1 --branch "$KITREF" -q
   echo "$DIR/workflows"
   ```

3. **Run the wrapper by path**, merging the repo's config with any `$ARGUMENTS` the user passed and pointing the nested children at the cloned kit:
   - Read `$CFG` into an object `cfg`.
   - `Workflow({ scriptPath: "<DIR>/workflows/ship-issues.js", args: { ...cfg, _dir: "<DIR>/workflows", ...$ARGUMENTS } })`
   - If `$ARGUMENTS` is empty, just pass `{ ...cfg, _dir: "<DIR>/workflows" }` (defaults: discover open `action` issues, `apply: true`, squash-merge into the configured base).
   - `$ARGUMENTS` may be a JSON object (`{"apply":false}`, `{"issues":[29,30]}`) or a bare array of issue numbers (`[29,30]`) — merge an object in directly; if it's an array, pass it as `issues`.

4. **Report** when it finishes: issues planned vs deferred, PRs opened (with the merge order), the review gate outcome (which PRs passed, which were **held for a human** after exhausting fix iterations, and the lens-divergence rate), what merged vs where it stopped, any blocked issues, and any issues closed by the train.

`ship-issues` runs `parallel-issues` (plan → implement each issue on an isolated worktree → verify with the repo's configured checks → open one PR per issue against the base), then runs an **adversarial review gate** on each PR (default 3 independent full-scope reviewers; a flagged PR is re-fixed from the review feedback and re-reviewed up to `maxFixIterations` times — default 2 — before being held open for a human), and finally feeds the PRs that **passed review** into `merge-train` with `apply: true` (each PR merged only after its merged tree passes verify; resolved issues are closed explicitly since the base is not the default branch).

Review knobs (all optional in `$ARGUMENTS`): `apply:false` produces PRs + a local dry-run integration with nothing merged; `review:false` skips the gate; `reviewLenses` (1–3, default 3) sets reviewers per PR; `fullScope:false` reverts to the partitioned correctness/regressions/conventions lenses; `maxFixIterations` (default 2) caps the re-fix attempts before holding.
