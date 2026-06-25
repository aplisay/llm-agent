# Implementation & design docs (internal)

Internal engineering design docs, plans, and decision records for llm-agent —
**how things are built and why**. These are *not* user-facing API documentation
(the OpenAPI spec under `api/` and the generated `API.md` cover the public
surface).

Docs may be **DRAFT / awaiting review** and describe work that is not yet
implemented — each states its status at the top.

## Index

| Doc | What it covers | Status |
|---|---|---|
| [better-auth-migration-plan.md](./better-auth-migration-plan.md) | The canonical Firebase → Better-Auth migration plan (phasing, target schema, RBAC vocabulary, risks, open decisions). | Baseline |
| [better-auth-hardening-plan.md](./better-auth-hardening-plan.md) | Gap analysis of the Better-Auth proto vs production-real (running in parallel with Firebase): what's DONE / PARTIAL / TODO, file-level steps, risk register. | DRAFT — awaiting review |
| [users-api-design.md](./users-api-design.md) | The `/api/users` resource — provisional-user signup (waitlist + future self-signup), the API-operation gate, and the admin user-lifecycle/management API. | DRAFT — awaiting review |
| [rbac-implementation-plan.md](./rbac-implementation-plan.md) | RBAC *enforcement* (the migration plan's §4, wired) + four new requirements: prefix-based model access control, org-inherited (baseline) permissions, org-scoped user admin, and cross-tenant super admin. The `/api/organisations` CRUD + the frontend org-edit modal. | DRAFT — awaiting review |
