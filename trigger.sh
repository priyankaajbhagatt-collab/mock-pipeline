#!/usr/bin/env bash
#
# trigger.sh — fire a mock CI pipeline run for a service.
#
# Usage:
#   ./trigger.sh comorderas
#   ./trigger.sh copayment
#   ./trigger.sh coprofile
#
# What happens:
#   1. Creates a trivial source.zip with a timestamp inside
#   2. Uploads it to s3://backstage-idp-mock-source-<account>/services/<svc>/source.zip
#   3. S3 fires a PutObject event → EventBridge rule (installed by CDK) triggers
#      the CI pipeline Ngcom<Cap(svc)>AppPipeline
#   4. CI pipeline runs ~30s, cascade Lambda then starts the 3 market CD pipelines
#
# Timeline: ~65s end-to-end; ~$0.03 in CodeBuild charges.
#
set -euo pipefail

SERVICE="${1:-}"
if [[ -z "$SERVICE" ]]; then
  echo "Usage: $0 <service>" >&2
  echo "  Known services: comorderas, copayment, coprofile" >&2
  exit 1
fi

# Known services list — keep in sync with infra/lib/stage-defs.ts SERVICES
case "$SERVICE" in
  comorderas|copayment|coprofile) ;;
  *)
    echo "Error: unknown service '$SERVICE'" >&2
    echo "  Known services: comorderas, copayment, coprofile" >&2
    exit 1
    ;;
esac

# Capitalize first letter for the pipeline name
CAP_SERVICE="$(echo "${SERVICE:0:1}" | tr '[:lower:]' '[:upper:]')${SERVICE:1}"
PIPELINE_NAME="github-Ngcom${CAP_SERVICE}AppPipeline"

# Configurable via env — defaults are the project standard values
BUCKET="${BUCKET:-backstage-idp-mock-source-381492075615}"
KEY="services/${SERVICE}/source.zip"
PROFILE="${AWS_PROFILE:-Altimetrik-PowerUserAccess-381492075615}"
REGION="${AWS_REGION:-us-east-1}"

# Build the zip in a tmp dir (auto-cleanup on exit)
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

TIMESTAMP="$(date -u +%FT%TZ)"
echo "trigger ${SERVICE} at ${TIMESTAMP}" > "$TMPDIR/trigger.txt"
(cd "$TMPDIR" && zip -q source.zip trigger.txt)

echo "→ Uploading ${KEY} to s3://${BUCKET}/ ..."
aws s3 cp "$TMPDIR/source.zip" "s3://${BUCKET}/${KEY}" \
  --profile "$PROFILE" \
  --region "$REGION" \
  --no-progress

echo ""
echo "✓ Triggered ${PIPELINE_NAME} at ${TIMESTAMP}"
echo ""
echo "Watch the run with:"
echo "  aws codepipeline get-pipeline-state --name ${PIPELINE_NAME} --profile ${PROFILE} --region ${REGION}"
echo ""
echo "Or in the console:"
echo "  https://${REGION}.console.aws.amazon.com/codesuite/codepipeline/pipelines/${PIPELINE_NAME}/view?region=${REGION}"
echo ""
echo "Expected cascade: ~30s after CI success, the 3 market CD pipelines will start:"
echo "  - github-Ngcom${CAP_SERVICE}ThaAppPipeline"
echo "  - github-Ngcom${CAP_SERVICE}JpAppPipeline"
echo "  - github-Ngcom${CAP_SERVICE}LatamAppPipeline"
