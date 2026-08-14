#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-capere-ai-786a0}"
REGION="${GOOGLE_CLOUD_REGION:-asia-south1}"
API_SERVICE="${CAPERE_API_SERVICE:-capere-backend}"
TASK_QUEUE="${CAPERE_TASK_QUEUE:-capere-integration-jobs}"
RAG_BUCKET="${CAPERE_RAG_BUCKET:-${PROJECT_ID}-rag-sources}"
ENABLE_SCHEDULERS="${CAPERE_ENABLE_SCHEDULERS:-false}"
MANAGED_TASK_URL="${CAPERE_MANAGED_TASK_URL:-}"
MANAGED_TASK_AUDIENCE="${CAPERE_MANAGED_TASK_AUDIENCE:-$MANAGED_TASK_URL}"

gcloud services enable \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  identitytoolkit.googleapis.com \
  cloudbuild.googleapis.com \
  --project "$PROJECT_ID"

# Enabling Identity Toolkit does not create the Firebase Auth configuration.
# Without this one-time initialization, Firebase Admin user provisioning fails
# with CONFIGURATION_NOT_FOUND during embedded GoHighLevel SSO.
ACCESS_TOKEN="$(gcloud auth print-access-token)"
AUTH_CONFIG_URL="https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config"
AUTH_CONFIG_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "x-goog-user-project: $PROJECT_ID" \
  "$AUTH_CONFIG_URL")"
if [[ "$AUTH_CONFIG_STATUS" == "404" ]]; then
  curl -fsS -X POST \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "x-goog-user-project: $PROJECT_ID" \
    -H 'Content-Type: application/json' \
    -d '{}' \
    "https://identitytoolkit.googleapis.com/v2/projects/$PROJECT_ID/identityPlatform:initializeAuth" >/dev/null
elif [[ "$AUTH_CONFIG_STATUS" != "200" ]]; then
  echo "Could not inspect Firebase Auth configuration (HTTP $AUTH_CONFIG_STATUS)" >&2
  exit 1
fi

gcloud artifacts repositories describe capere --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud artifacts repositories create capere --repository-format docker --location "$REGION" --project "$PROJECT_ID"

for account in capere-api capere-tasks; do
  gcloud iam service-accounts describe "$account@$PROJECT_ID.iam.gserviceaccount.com" --project "$PROJECT_ID" >/dev/null 2>&1 || \
    gcloud iam service-accounts create "$account" --display-name "$account" --project "$PROJECT_ID"
done

gcloud tasks queues describe "$TASK_QUEUE" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud tasks queues create "$TASK_QUEUE" --location "$REGION" --max-concurrent-dispatches 10 --max-dispatches-per-second 10 --max-attempts 5 --min-backoff 5s --max-backoff 3600s --max-doublings 8 --project "$PROJECT_ID"
gcloud tasks queues update "$TASK_QUEUE" \
  --location "$REGION" \
  --max-concurrent-dispatches 10 \
  --max-dispatches-per-second 10 \
  --max-attempts 5 \
  --min-backoff 5s \
  --max-backoff 3600s \
  --max-doublings 8 \
  --project "$PROJECT_ID" >/dev/null

gcloud storage buckets describe "gs://$RAG_BUCKET" --project "$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://$RAG_BUCKET" --location "$REGION" --uniform-bucket-level-access --public-access-prevention --project "$PROJECT_ID"

gcloud storage buckets update "gs://$RAG_BUCKET" --versioning --project "$PROJECT_ID"

gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:capere-api@$PROJECT_ID.iam.gserviceaccount.com" --role roles/cloudtasks.enqueuer --condition=None >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$RAG_BUCKET" --member "serviceAccount:capere-api@$PROJECT_ID.iam.gserviceaccount.com" --role roles/storage.objectAdmin >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$RAG_BUCKET" --member "serviceAccount:capere-api@$PROJECT_ID.iam.gserviceaccount.com" --role roles/storage.legacyBucketReader >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:capere-api@$PROJECT_ID.iam.gserviceaccount.com" --role roles/secretmanager.secretAccessor --condition=None >/dev/null
gcloud iam service-accounts add-iam-policy-binding "capere-tasks@$PROJECT_ID.iam.gserviceaccount.com" --member "serviceAccount:capere-api@$PROJECT_ID.iam.gserviceaccount.com" --role roles/iam.serviceAccountUser --project "$PROJECT_ID" >/dev/null
gcloud iam service-accounts add-iam-policy-binding "capere-api@$PROJECT_ID.iam.gserviceaccount.com" --member "serviceAccount:capere-api@$PROJECT_ID.iam.gserviceaccount.com" --role roles/iam.serviceAccountTokenCreator --condition=None --project "$PROJECT_ID" >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:capere-api@$PROJECT_ID.iam.gserviceaccount.com" --role roles/firebaseauth.admin --condition=None >/dev/null

API_URL="$(gcloud run services describe "$API_SERVICE" --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)' 2>/dev/null || true)"
if [[ "$ENABLE_SCHEDULERS" == "true" && -n "$API_URL" ]]; then
  MANAGED_TASK_URL="${MANAGED_TASK_URL:-$API_URL}"
  MANAGED_TASK_AUDIENCE="${MANAGED_TASK_AUDIENCE:-$MANAGED_TASK_URL}"
  gcloud run services add-iam-policy-binding "$API_SERVICE" --region "$REGION" --project "$PROJECT_ID" --member "serviceAccount:capere-tasks@$PROJECT_ID.iam.gserviceaccount.com" --role roles/run.invoker >/dev/null
  for job in scheduler outbox rag; do
    case "$job" in
      scheduler) path="scheduler/tick"; schedule="*/1 * * * *" ;;
      outbox) path="outbox/tick"; schedule="*/1 * * * *" ;;
      rag) path="rag/tick"; schedule="*/1 * * * *" ;;
    esac
    gcloud scheduler jobs describe "capere-$job" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 && \
      gcloud scheduler jobs update http "capere-$job" --location "$REGION" --schedule "$schedule" --uri "$MANAGED_TASK_URL/api/v1/internal/jobs/$path" --http-method POST --oidc-service-account-email "capere-tasks@$PROJECT_ID.iam.gserviceaccount.com" --oidc-token-audience "$MANAGED_TASK_AUDIENCE" --project "$PROJECT_ID" >/dev/null || \
      gcloud scheduler jobs create http "capere-$job" --location "$REGION" --schedule "$schedule" --uri "$MANAGED_TASK_URL/api/v1/internal/jobs/$path" --http-method POST --oidc-service-account-email "capere-tasks@$PROJECT_ID.iam.gserviceaccount.com" --oidc-token-audience "$MANAGED_TASK_AUDIENCE" --project "$PROJECT_ID" >/dev/null
  done
elif [[ "$ENABLE_SCHEDULERS" == "true" ]]; then
  echo "Cloud Run service $API_SERVICE is not deployed yet; scheduler jobs were not created."
else
  echo "Managed schedulers remain disabled. Set CAPERE_ENABLE_SCHEDULERS=true only during cutover after stopping PM2 workers."
fi

echo "Provisioning complete for project $PROJECT_ID in $REGION."
echo "Database: external Supabase PostgreSQL configured through Secret Manager"
echo "RAG bucket: gs://$RAG_BUCKET"
