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
creates the regional Cloud SQL instance, Artifact Registry repository, Cloud
Tasks queue, private RAG bucket, service accounts, and IAM grants. Scheduler
jobs are intentionally disabled by default; set
`CAPERE_ENABLE_SCHEDULERS=true` only during the cutover window after PM2
workers have been stopped.

Deploy the fully managed backend with `cloudbuild.backend.yaml`. Store all values currently
held in `.env` in Secret Manager and attach them to the Cloud Run service. Never
place provider credentials or encryption keys directly in Cloud Build YAML.
Use a Cloud SQL Unix-socket connection string with `DATABASE_SSL_MODE=disable`;
the Cloud SQL connector authenticates and encrypts that local socket path. The
database login used by the API must be the migration-created `service_role`,
which has `BYPASSRLS`; user-scoped calls still execute `SET LOCAL ROLE
authenticated` so the existing RLS policies remain the tenant backstop.

## Cutover order

1. Provision resources and secrets.
2. Deploy Cloud Run with `AUTH_PROVIDER=supabase`, `JOB_DISPATCH_MODE=redis`, and
   `RAG_STORAGE_PROVIDER=supabase` against the current services.
3. Verify OAuth callbacks, webhooks, GHL SSO, Ask CMO, SEO, and health checks.
4. Restore a production snapshot into Cloud SQL and run all RLS tests.
5. Enable Firebase Auth and GCS in staging.
6. During maintenance, stop PM2 workers, run the final database migration,
   point Cloud Run at Cloud SQL, and enable Cloud Tasks/Scheduler.
7. Move `api.capereai.com` only after direct Cloud Run verification.
8. Keep the VPS stopped but recoverable for at least seven days.

The rehearsal completed against the managed snapshot with exact validation:
12 organizations, 8 users, 1,064 rows, 48 RLS-enabled tables, and 63 RLS
policies. The isolated managed Cloud Run revision also passed readiness for
Cloud SQL, pgvector, GCS, and OpenRouter. This does not switch production
traffic.

Do not run the PM2 worker and Cloud Scheduler/Tasks against the same production
database simultaneously.

The checked-in `cloudbuild.backend.yaml` deploys the final managed runtime with:

- `AUTH_PROVIDER=firebase`
- `FIREBASE_PROJECT_ID=capere-ai-786a0`
- `DATABASE_SSL_MODE=disable`
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

For a pre-DNS managed deployment, override `_SERVICE` and `_PUBLIC_API_URL`:

```bash
gcloud builds submit --region asia-south1 \
  --config cloudbuild.backend.yaml \
  --substitutions=_SERVICE=capere-backend-managed,_PUBLIC_API_URL=https://MANAGED_SERVICE_URL .
```

During cutover, deploy the default `capere-backend` service with
`_PUBLIC_API_URL=https://api.capereai.com`, verify it directly, update DNS, then
deploy App Hosting. Enable schedulers last with both task values explicit:

```bash
CAPERE_ENABLE_SCHEDULERS=true \
CAPERE_MANAGED_TASK_URL=https://api.capereai.com \
CAPERE_MANAGED_TASK_AUDIENCE=https://api.capereai.com \
scripts/cloud/provision.sh
```
