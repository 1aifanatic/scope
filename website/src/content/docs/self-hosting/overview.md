---
title: Self-hosting
description: Provision Scope infrastructure on Azure and deploy the application to AKS with Helm.
---

Scope includes a resource-group-scoped Azure deployment and a Helm chart for
running the platform on Azure Kubernetes Service (AKS). The supported
self-hosting flow has three phases:

1. Provision Azure infrastructure from
   [`deploy/azure`](https://github.com/microsoft/scope/tree/main/deploy/azure).
2. Install the six core services with the
   [`deploy/helm/scope`](https://github.com/microsoft/scope/tree/main/deploy/helm/scope)
   chart.
3. Build and enable the two ACP coding-agent workers with
   [`scripts/bootstrap-workers.sh`](https://github.com/microsoft/scope/blob/main/scripts/bootstrap-workers.sh).

The Azure template is an open-source quickstart. It is separate from the
repository's internal development infrastructure.

## Architecture

The infrastructure template creates the network, AKS cluster, managed data
services, container registry, and workload identities. Helm installs the
application into the `scope` namespace.

```mermaid
flowchart TD
    User[Administrator] --> Azure[deploy/azure Bicep]
    Azure --> AKS[AKS: System and User Linux pools]
    Azure --> Data[Cosmos DB, Managed Redis, Storage]
    Azure --> KV[Key Vault]
    Azure --> ACR[Azure Container Registry]
    User --> Helm[deploy/helm/scope]
    Helm --> Core[API, Portal, Judge, Token Manager, Scheduler, Report Generator]
    Helm --> Workers[Optional Copilot and Claude Code workers]
    GHCR[Public GHCR images] --> Core
    ACR --> Workers
    KV --> CSI[Key Vault Secrets Provider CSI]
    CSI --> Core
    Data --> Core
    Data --> Workers
```

AKS has one fixed-size System node pool and one fixed-size User Linux node
pool. OIDC and workload identity are enabled. The native Azure Key Vault
Secrets Provider add-on syncs selected Key Vault objects into one Kubernetes
Secret.

The core images come from `ghcr.io/microsoft`. The API builder-stage image
runs database migrations. The ACP worker images are built in the provisioned
ACR because they are enabled separately after the core install.

## Installed workloads

| Workload | Chart resource | Purpose |
| --- | --- | --- |
| API | Deployment and `api` Service | REST API and orchestration |
| Portal | Deployment and `scope-portal` Service | Web interface |
| Judge | Deployment and Service | Criteria evaluation |
| Token Manager | Deployment and Service | Provider credential management |
| Scheduler | Deployment and Service | Request scheduling |
| Report Generator | Deployment | Background report generation |
| Database migration | Post-install/post-upgrade Job | Applies MongoDB migrations |
| Copilot worker | Optional Deployment | GitHub Copilot through ACP |
| Claude Code worker | Optional Deployment | Claude Code through ACP |

Each coding-agent worker can run an MCPJungle native sidecar for MCP server
aggregation. The chart does not yet template the AI Gateway/DevProxy sidecar
or Kubedock, so scenarios that require HAR capture or in-task Docker access
are not supported by this deployment.

The chart also does not install an ingress controller, DNS, TLS,
cert-manager, autoscaling, or an observability stack.

## Identity boundary

The deployment creates two federated user-assigned identities:

- The backend identity can access Key Vault, Redis, Blob Storage, and queues.
- The worker identity can access Blob Storage and queues only. It has no Key
  Vault role because worker pods execute benchmark-controlled agent code.

Worker credentials should be registered through the Portal's **Secrets** tab
or the Token Manager API. Static Key Vault objects are available only as a
fallback.

## Prerequisites

- An Azure subscription and permission to create resources and role
  assignments in a resource group.
- Azure CLI with Bicep when deploying from the command line.
- `kubectl`, Helm, `jq`, and access to the repository checkout.
- Provider credentials for the coding agents and models you enable.

Continue with [Provision Azure infrastructure](/self-hosting/provision-aks/),
then [Deploy with Helm](/self-hosting/deploy-helm/).
