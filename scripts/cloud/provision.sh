#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-capere-ai-786a0}"
REGION="${GOOGLE_CLOUD_REGION:-asia-south1}"
API_SERVICE="${CAPERE_API_SERVICE:-capere-backend}"
SQL_INSTANCE="${CAPERE_SQL_INSTANCE:-capere-postgres}"
TASK_QUEUE="${CAPERE_TASK_QUEUE:-capere-integration-jobs}"
RAG_BUCKET="${CAPERE_RAG_BUCKET:-${PROJECT_ID}-rag-sources}"

gcloud services enable \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  sqladmin.googleapis.com \
  cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  identitytoolkit.googleapis.com \
  cloudbuild.googleapis.com \
  --project "$PROJECT_ID"

gcloud artifacts repositories describe capere --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud artifacts repositories create capere --repository-format docker --location "$REGION" --project "$PROJECT_ID"

for account in capere-api capere-tasks; do
  gcloud iam service-accounts describe "$account@$PROJECT_ID.iam.gserviceaccount.com" --project "$PROJECT_ID" >/dev/null 2>&1 || \
    gcloud iam service-accounts create "$account" --display-name "$account" --project "$PROJECT_ID"
done

gcloud sql instances describe "$SQL_INSTANCE" --project "$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud sql instances create "$SQL_INSTANCE" \
    --database-version POSTGRES_17 \
    --region "$REGION" \
    --tier db-custom-2-7680 \
    --storage-type SSD \
    --storage-size 20 \
    --storage-auto-increase \
    --availability-type regional \
    --backup-start-time 20:00 \
    --enable-point-in-time-recovery \
    --project "$PROJECT_ID"

gcloud sql databases describe capere --instance "$SQL_INSTANCE" --project "$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud sql databases create capere --instance "$SQL_INSTANCE" --project "$PROJECT_ID"

gcloud tasks queues describe "$TASK_QUEUE" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud tasks queues create "$TASK_QUEUE" --location "$REGION" --max-concurrent-dispatches 10 --max-dispatches-per-second 10 --project "$PROJECT_ID"

gcloud storage buckets describe "gs://$RAG_BUCKET" --project "$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://$RAG_BUCKET" --location "$REGION" --uniform-bucket-level-access --public-access-prevention --project "$PROJECT_ID"

gcloud storage buckets update "gs://$RAG_BUCKET" --versioning --project "$PROJECT_ID"

gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:capere-api@$PROJECT_ID.iam.gserviceaccount.com" --role roles/cloudsql.client >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:capere-api@$PROJECT_ID.iam.gserviceaccount.com" --role roles/cloudtasks.enqueuer >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$RAG_BUCKET" --member "serviceAccount:capere-api@$PROJECT_ID.iam.gserviceaccount.com" --role roles/storage.objectAdmin >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:capere-api@$PROJECT_ID.iam.gserviceaccount.com" --role roles/secretmanager.secretAccessor >/dev/null
gcloud iam service-accounts add-iam-policy-binding "capere-tasks@$PROJECT_ID.iam.gserviceaccount.com" --member "serviceAccount:capere-api@$PROJECT_ID.iam.gserviceaccount.com" --role roles/iam.serviceAccountUser --project "$PROJECT_ID" >/dev/null

API_URL="$(gcloud run services describe "$API_SERVICE" --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)' 2>/dev/null || true)"
if [[ -n "$API_URL" ]]; then
  gcloud run services add-iam-policy-binding "$API_SERVICE" --region "$REGION" --project "$PROJECT_ID" --member "serviceAccount:capere-tasks@$PROJECT_ID.iam.gserviceaccount.com" --role roles/run.invoker >/dev/null
  for job in scheduler outbox rag; do
    case "$job" in
      scheduler) path="scheduler/tick"; schedule="*/1 * * * *" ;;
      outbox) path="outbox/tick"; schedule="*/1 * * * *" ;;
      rag) path="rag/tick"; schedule="*/1 * * * *" ;;
    esac
    gcloud scheduler jobs describe "capere-$job" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 && \
      gcloud scheduler jobs update http "capere-$job" --location "$REGION" --schedule "$schedule" --uri "$API_URL/api/v1/internal/jobs/$path" --http-method POST --oidc-service-account-email "capere-tasks@$PROJECT_ID.iam.gserviceaccount.com" --oidc-token-audience "$API_URL" --project "$PROJECT_ID" >/dev/null || \
      gcloud scheduler jobs create http "capere-$job" --location "$REGION" --schedule "$schedule" --uri "$API_URL/api/v1/internal/jobs/$path" --http-method POST --oidc-service-account-email "capere-tasks@$PROJECT_ID.iam.gserviceaccount.com" --oidc-token-audience "$API_URL" --project "$PROJECT_ID" >/dev/null
  done
else
  echo "Cloud Run service $API_SERVICE is not deployed yet; scheduler jobs were not created."
fi

echo "Provisioning complete for project $PROJECT_ID in $REGION."
echo "Cloud SQL connection: $PROJECT_ID:$REGION:$SQL_INSTANCE"
echo "RAG bucket: gs://$RAG_BUCKET"
