# Google-managed production migration

This repository supports a reversible migration from the VPS runtime to the
existing Firebase/Google Cloud project.

## Runtime modes

The migration flags intentionally default to the current production behavior:

- `AUTH_PROVIDER=supabase|firebase`
- `JOB_DISPATCH_MODE=redis|cloud_tasks`
- `RAG_STORAGE_PROVIDER=supabase|gcs`

Switch them independently in staging, then together during production cutover.

## Provisioning

Run `scripts/cloud/provision.sh` with an authenticated `gcloud` CLI. The script
creates the Artifact Registry repository, Cloud Tasks queue, private RAG
bucket, service accounts, and IAM grants. The production database is the
existing Supabase PostgreSQL project; Cloud SQL is no longer part of the
runtime. Scheduler
jobs are intentionally disabled by default; set
`CAPERE_ENABLE_SCHEDULERS=true` only during the cutover window after PM2
workers have been stopped.

Provisioning also initializes the Firebase Authentication configuration. Merely
enabling `identitytoolkit.googleapis.com` is insufficient; without the one-time
initialization Firebase Admin user provisioning fails with
`CONFIGURATION_NOT_FOUND` during embedded GoHighLevel SSO.

Deploy the fully managed backend with `cloudbuild.backend.yaml`. Store all values currently
held in `.env` in Secret Manager and attach them to the Cloud Run service. Never
place provider credentials or encryption keys directly in Cloud Build YAML.
Use the Supabase PostgreSQL session pooler with `DATABASE_SSL_MODE=verify` and
the CA certificate stored in `CAPERE_DATABASE_SSL_CA_BASE64`. The database
login used by the API must be `service_role`,
which has `BYPASSRLS`; user-scoped calls still execute `SET LOCAL ROLE
authenticated` so the existing RLS policies remain the tenant backstop.

## Cutover order

1. Provision resources and secrets.
2. Deploy Cloud Run with `AUTH_PROVIDER=supabase`, `JOB_DISPATCH_MODE=redis`, and
   `RAG_STORAGE_PROVIDER=supabase` against the current services.
3. Verify OAuth callbacks, webhooks, GHL SSO, Ask CMO, SEO, and health checks.
4. Restore a production snapshot into Supabase and run all RLS tests.
5. Enable Firebase Auth and GCS in staging.
6. During maintenance, stop PM2 workers, run the final database migration,
   point Cloud Run at Supabase, and enable Cloud Tasks/Scheduler.
7. Move `api.capereai.com` only after direct Cloud Run verification.
8. Keep the VPS stopped but recoverable for at least seven days.

The final migration completed with 12 organizations, 9 users, 1,160 Capere
rows, 48 RLS-enabled tables, and 63 RLS policies. Production Cloud Run passed
readiness against Supabase PostgreSQL, pgvector, GCS, and OpenRouter before
traffic was switched.

Do not run the PM2 worker and Cloud Scheduler/Tasks against the same production
database simultaneously.

The checked-in `cloudbuild.backend.yaml` deploys the final managed runtime with:

- `AUTH_PROVIDER=firebase`
- `FIREBASE_PROJECT_ID=capere-ai-786a0`
- `DATABASE_SSL_MODE=verify`
- `DATABASE_POOL_MAX=2`
- `JOB_DISPATCH_MODE=cloud_tasks`
- `GOOGLE_CLOUD_PROJECT=capere-ai-786a0`
- `CLOUD_TASKS_LOCATION=asia-south1`
- `CLOUD_TASKS_QUEUE=capere-integration-jobs`
- `MANAGED_TASK_AUDIENCE=<Cloud Run service URL>`
- `MANAGED_TASK_SERVICE_ACCOUNT=capere-tasks@capere-ai-786a0.iam.gserviceaccount.com`
- `RAG_STORAGE_PROVIDER=gcs`
- `RAG_STORAGE_BUCKET=capere-ai-786a0-rag-sources`

`cloudbuild.backend.compat.yaml` is the explicit rollback build for the retained
Supabase/Redis environment. Do not use it for normal production deployments.

The App Hosting manifest is configured for Firebase Auth and requires the
`CAPERE_FIREBASE_WEB_API_KEY` secret. Deploy it only after the managed backend
is serving `api.capereai.com`; deploying the frontend first would make its
Firebase session cookies incompatible with the compatibility backend.

Embedded SSO exchanges the short-lived Firebase ID token for an eight-hour,
HTTP-only Firebase session cookie on the backend. Do not store a raw one-hour ID
token as the browser session or an iframe left open during the workday will
silently lose API access.

The managed integration queue retains the former BullMQ retry policy: five
attempts with exponential backoff. Avoid Cloud Tasks' default 100 attempts,
which can amplify permanent provider failures and duplicate external work.

The temporary pre-DNS `capere-backend-managed` service used during the original
cutover has been retired. Production deployments must target the default
`capere-backend` service with `_PUBLIC_API_URL=https://api.capereai.com`.
Enable schedulers with both task values explicit:

```bash
CAPERE_ENABLE_SCHEDULERS=true \
CAPERE_MANAGED_TASK_URL=https://api.capereai.com \
CAPERE_MANAGED_TASK_AUDIENCE=https://api.capereai.com \
scripts/cloud/provision.sh
```
