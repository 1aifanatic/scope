#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
#
# One-shot setup for the core Scope app (Phase 2): reads the outputs of an
# already-provisioned `deploy/azure/` Bicep deployment, generates a Helm
# values file from them, and installs/upgrades the chart. Closes the gap
# between Bicep's outputs and a hand-authored values.yaml, which is where
# transcription mistakes (wrong Redis port, stale Key Vault name, etc.) have
# historically crept in.
#
# Usage:
#   scripts/bootstrap-core.sh --resource-group <name> [options]
#
# Options:
#   --resource-group <name>  Resource group the Bicep template deployed into
#                            (required unless --skip-generate).
#   --deployment-name <name> Deployment within that resource group to read
#                            outputs from (required unless --skip-generate).
#                            This is never auto-selected — a resource group
#                            can contain multiple deployments (re-runs,
#                            nested templates), and guessing could silently
#                            read the wrong one's outputs. List candidates
#                            first and choose explicitly:
#                              az deployment group list -g <rg> \
#                                --query "[].{name:name, timestamp:properties.timestamp}" \
#                                -o table
#   --namespace <ns>         Kubernetes namespace (default: scope)
#   --release <name>         Helm release name (default: scope)
#   --chart <path>           Helm chart path (default: deploy/helm/scope,
#                            relative to repo root)
#   --values-file <path>     Where to write the generated values file
#                            (default: my-values.yaml). If this file already
#                            exists, the script refuses to overwrite it
#                            unless --force is also given.
#   --image-registry <reg>   Baked into the generated file as
#                            global.imageRegistry (e.g. your own fork's GHCR
#                            namespace, or the Bicep-provisioned ACR). Omit
#                            to use the chart's ghcr.io/microsoft default.
#                            Always written into the file itself — never
#                            passed as an ad-hoc `helm --set` — so a later
#                            `helm upgrade -f <values-file>` (e.g. from
#                            bootstrap-workers.sh) can't silently drop it.
#   --force                  Overwrite --values-file if it already exists.
#   --skip-generate          Skip the Azure lookups entirely and just
#                            install/upgrade using an existing --values-file
#                            (e.g. after you've hand-edited it for ingress
#                            hosts or other overrides).
#   --dry-run                Generate the values file but skip the Helm
#                            install/upgrade step.
#   --set <key=value>        Extra Helm --set override; repeatable.
#   -h, --help                Show this help.
#
# Requires: az (logged in, correct subscription active), jq, helm, kubectl.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RESOURCE_GROUP=""
DEPLOYMENT_NAME=""
NAMESPACE="scope"
RELEASE_NAME="scope"
CHART_PATH="deploy/helm/scope"
VALUES_FILE="my-values.yaml"
IMAGE_REGISTRY=""
FORCE=false
SKIP_GENERATE=false
DRY_RUN=false
EXTRA_SET=()

usage() {
  sed -n '2,50p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group) RESOURCE_GROUP="$2"; shift 2 ;;
    --deployment-name) DEPLOYMENT_NAME="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --release) RELEASE_NAME="$2"; shift 2 ;;
    --chart) CHART_PATH="$2"; shift 2 ;;
    --values-file) VALUES_FILE="$2"; shift 2 ;;
    --image-registry) IMAGE_REGISTRY="$2"; shift 2 ;;
    --force) FORCE=true; shift ;;
    --skip-generate) SKIP_GENERATE=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --set) EXTRA_SET+=("--set" "$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

cd "$REPO_ROOT"

for bin in helm kubectl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: $bin not found on PATH" >&2; exit 1; }
done

if [[ "$SKIP_GENERATE" != true ]]; then
  for bin in az jq; do
    command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: $bin not found on PATH" >&2; exit 1; }
  done

  [[ -n "$RESOURCE_GROUP" ]] || { echo "ERROR: --resource-group is required (or pass --skip-generate to reuse an existing values file)" >&2; usage; exit 1; }

  if [[ -z "$DEPLOYMENT_NAME" ]]; then
    echo "ERROR: --deployment-name is required. List deployments in '$RESOURCE_GROUP' and pick one:" >&2
    echo "  az deployment group list -g $RESOURCE_GROUP --query \"[].{name:name, timestamp:properties.timestamp}\" -o table" >&2
    exit 1
  fi

  if [[ -f "$VALUES_FILE" && "$FORCE" != true ]]; then
    echo "ERROR: $VALUES_FILE already exists. Pass --force to overwrite it, --values-file <other path> to write elsewhere, or --skip-generate to install using it as-is." >&2
    exit 1
  fi

  echo "==> Reading Bicep outputs from $RESOURCE_GROUP/$DEPLOYMENT_NAME"
  OUTPUTS_JSON="$(az deployment group show -g "$RESOURCE_GROUP" -n "$DEPLOYMENT_NAME" --query properties.outputs -o json)"

  get_output() {
    jq -r --arg k "$1" '.[$k].value // empty' <<<"$OUTPUTS_JSON"
  }

  TENANT_ID="$(az account show --query tenantId -o tsv)"
  KEY_VAULT_NAME="$(get_output keyVaultName)"
  KEY_VAULT_URI="$(get_output keyVaultUri)"
  WORKLOAD_IDENTITY_CLIENT_ID="$(get_output workloadIdentityClientId)"
  SERVICE_ACCOUNT_NAME="$(get_output workloadIdentityServiceAccountName)"
  STORAGE_ACCOUNT_NAME="$(get_output storageAccountName)"
  REDIS_HOST_NAME="$(get_output redisHostName)"
  REDIS_PORT="$(get_output redisPort)"

  for pair in \
    "tenantId:$TENANT_ID" \
    "keyVaultName:$KEY_VAULT_NAME" \
    "keyVaultUri:$KEY_VAULT_URI" \
    "workloadIdentityClientId:$WORKLOAD_IDENTITY_CLIENT_ID" \
    "workloadIdentityServiceAccountName:$SERVICE_ACCOUNT_NAME" \
    "storageAccountName:$STORAGE_ACCOUNT_NAME" \
    "redisHostName:$REDIS_HOST_NAME" \
    "redisPort:$REDIS_PORT"
  do
    key="${pair%%:*}"
    val="${pair#*:}"
    if [[ -z "$val" ]]; then
      echo "ERROR: value for '$key' was empty. Check --resource-group/--deployment-name point at the right Bicep deployment." >&2
      exit 1
    fi
  done

  echo "==> Writing $VALUES_FILE"
  {
    if [[ -n "$IMAGE_REGISTRY" ]]; then
      cat <<EOF
global:
  imageRegistry: $IMAGE_REGISTRY

EOF
    fi
    cat <<EOF
azure:
  tenantId: $TENANT_ID
  keyVaultName: $KEY_VAULT_NAME
  keyVaultUri: $KEY_VAULT_URI
  workloadIdentityClientId: $WORKLOAD_IDENTITY_CLIENT_ID
  serviceAccountName: $SERVICE_ACCOUNT_NAME
  storageAccountName: $STORAGE_ACCOUNT_NAME
  redisHostName: $REDIS_HOST_NAME
  redisPort: $REDIS_PORT
EOF
  } > "$VALUES_FILE"

  echo "    Done. Review/edit $VALUES_FILE (e.g. to add ingress hosts) before re-running if needed."
else
  [[ -f "$VALUES_FILE" ]] || { echo "ERROR: --skip-generate given but $VALUES_FILE does not exist" >&2; exit 1; }
  echo "==> --skip-generate set; reusing existing $VALUES_FILE"
fi

if [[ "$DRY_RUN" == true ]]; then
  echo "==> --dry-run set; skipping helm install/upgrade."
  exit 0
fi

echo "==> Installing/upgrading Helm release '$RELEASE_NAME' in namespace '$NAMESPACE'"
helm upgrade --install "$RELEASE_NAME" "$CHART_PATH" \
  --namespace "$NAMESPACE" --create-namespace \
  -f "$VALUES_FILE" \
  "${EXTRA_SET[@]}" \
  --wait --timeout 5m

cat <<EOF

Core app deployed. Next steps:
  kubectl -n $NAMESPACE get pods
  kubectl -n $NAMESPACE port-forward svc/scope-portal 5100:80
  # then open http://localhost:5100

Add any bring-your-own secrets (GitHub token, Anthropic API key), then bring
the ACP coding-agent workers online with scripts/bootstrap-workers.sh.
EOF
