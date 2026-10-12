# Artifact Registry cleanup

`cleanup-policy.json` is the cleanup policy for the `containers` repository
(`europe-west1-docker.pkg.dev/llm-voice/containers`). Artifact Registry runs it
by itself about once a day.

## What it does

Only packages under `llm-agent/` and `polite-ai-website/` are ever deleted. The
other packages in the repository (`aplisay-b2bua/`, `aplisay-mcp/`,
`aplisay-sbc/`) are not touched.

In those two paths a version is deleted when it is older than 14 days, unless:

- it has a tag that starts with `v`, `beta`, `next`, `staging` or `latest`, or
- it is one of the 10 newest versions of its package.

So these are kept for ever: every release (`v*`), every version that still has
a `beta-*` tag, and whatever `:beta`, `:next`, `:staging` and `:latest` point
at. Commit-SHA builds that were never promoted, feature builds and old staging
builds go after 14 days.

Keep rules always win over delete rules. The prefix is `beta`, not `beta-`, so
that the floating `:beta` tag is kept too. Do not put a time limit on the
`beta` prefix: it would also expire the image that `:beta` points at if no
beta ships within that time.

## Old betas

Each package keeps its 3 newest betas or every beta from the last 14 days,
whichever is more. A cleanup policy cannot count tags, so
`prune-beta-tags.mjs` removes the `beta-x.y.z` tags from older betas, and the
policy then deletes them like any other old build. It never touches the live
`:beta` image or anything with a `v*`, `next`, `staging` or `latest` tag.

```bash
node deploy/gcp/artifact-registry/prune-beta-tags.mjs           # report only
node deploy/gcp/artifact-registry/prune-beta-tags.mjs --apply   # remove the tags
```

It logs the full digest of each tag it removes. Until the policy runs, a tag
can be put back with
`gcloud artifacts docker tags add <pkg>@<digest> <pkg>:<tag>`.

It runs daily at 04:00 London time: the Cloud Scheduler job
`registry-prune-beta-tags` starts the manual Cloud Build trigger of the same
name, which runs `cloudbuild-prune-beta-tags.yaml` from `next`. Both run as
the `registry-cleanup` service account. On the `containers` repository that
account holds only a custom role with `artifactregistry.dockerimages.list` and
`artifactregistry.tags.delete`, so it can remove tags but not delete versions.

A release (`cloudbuild-release.yaml`) needs the `:$COMMIT_SHA` images of its
commit. Tag the release within 14 days of the main build, or it aborts at
Verify. Beta builds rebuild when the commit image is gone.

## Check before any change

```bash
node deploy/gcp/artifact-registry/check-cleanup.mjs \
  --kube-context do-ams3-k8s-1-36-0-do-1-ams3-1780735847909 \
  --kube-context do-lon1-k8s-1-36-0-do-2-lon1-1782604340196
```

It is read-only. It prints what the policy would keep and delete per package,
and exits 1 if a Cloud Run serving revision, a pod spec or a runner VM would
lose its image. `--show-deletes` lists every version it would delete.

## Apply

Dry run first. Dry-run results only appear in the Data Access audit log, so
`DATA_WRITE` audit logs must be on for `artifactregistry.googleapis.com` in
`llm-voice`.

```bash
gcloud artifacts repositories set-cleanup-policies containers \
  --project=llm-voice --location=europe-west1 \
  --policy=deploy/gcp/artifact-registry/cleanup-policy.json \
  --dry-run
```

With gcloud 462 this replaces every existing policy on the repository. Newer
gcloud versions need `--overwrite` to do that. After a day, read what it would
have deleted:

```bash
gcloud logging read --project=llm-voice --freshness=2d \
  'protoPayload.methodName="google.devtools.artifactregistry.v1.ArtifactRegistry.BatchDeleteVersions"
   AND protoPayload.request.validateOnly=true'
```

When that matches the check script, run the same `set-cleanup-policies`
command with `--no-dry-run` instead of `--dry-run`. To stop deleting, run it
again with `--dry-run`.
