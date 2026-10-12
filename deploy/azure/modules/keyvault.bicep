// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

@description('Azure region for all resources.')
param location string

@description('Tags to apply to all resources.')
param tags object = {}

@description('Name of the Key Vault. Must be globally unique.')
@minLength(3)
@maxLength(24)
param keyVaultName string

@description('Resource ID of the virtual network to link the private DNS zone to.')
param vnetResourceId string

@description('Resource ID of the subnet to deploy the Key Vault private endpoint into.')
param privateEndpointSubnetResourceId string

@description('Principal (object) ID of the workload identity to grant secrets read/write access to. Leave empty to skip the role assignment.')
param workloadIdentityPrincipalId string = ''

@description('Principal (object) IDs of additional identities to grant READ-ONLY secrets access to (e.g. a worker identity that needs to mount its own BYO credentials via the CSI Secrets Store driver, but must not be able to write/delete vault contents). Leave empty to skip these role assignments.')
param readOnlyPrincipalIds array = []

@description('Key Vault SKU name.')
@allowed([
  'standard'
  'premium'
])
param skuName string = 'standard'

@description('Number of days to retain soft-deleted vaults/objects.')
param softDeleteRetentionInDays int = 90

var keyVaultSecretsOfficerRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
)

// Key Vault Secrets User - read-only (get/list secrets), no write/delete.
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

var officerRoleAssignments = !empty(workloadIdentityPrincipalId)
  ? [
      {
        principalId: workloadIdentityPrincipalId
        // Secrets Officer (not just Secrets User/read-only) is required because the Token
        // Manager service (apps/token-manager) writes BYO credentials (e.g. GitHub/Anthropic
        // API keys) into this vault at runtime via SecretClient.setSecret(), using this same
        // shared workload identity - a read-only role 403s that write path.
        roleDefinitionIdOrName: keyVaultSecretsOfficerRoleDefinitionId
        principalType: 'ServicePrincipal'
      }
    ]
  : []

// Read-only consumers (e.g. a worker identity): the Secrets Store CSI driver mounts BYO
// credentials (GitHub/Anthropic keys) into every pod's filesystem via the shared
// SecretProviderClass, including worker pods, so a worker identity needs at least read
// access - but never write/delete, since workers run benchmark-controlled agent code and
// must not be able to tamper with or exfiltrate other secrets via overwrite.
var readOnlyRoleAssignments = [
  for principalId in filter(readOnlyPrincipalIds, id => !empty(id)): {
    principalId: principalId
    roleDefinitionIdOrName: keyVaultSecretsUserRoleDefinitionId
    principalType: 'ServicePrincipal'
  }
]

module privateDnsZone 'br/public:avm/res/network/private-dns-zone:0.7.0' = {
  name: '${deployment().name}-kv-dns-zone'
  params: {
    name: 'privatelink.vaultcore.azure.net'
    tags: tags
    virtualNetworkLinks: [
      {
        virtualNetworkResourceId: vnetResourceId
      }
    ]
  }
}

module keyVault 'br/public:avm/res/key-vault/vault:0.11.0' = {
  name: '${deployment().name}-kv'
  params: {
    name: keyVaultName
    location: location
    tags: tags
    sku: skuName
    enableRbacAuthorization: true
    publicNetworkAccess: 'Disabled'
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    enablePurgeProtection: true
    privateEndpoints: [
      {
        service: 'vault'
        subnetResourceId: privateEndpointSubnetResourceId
        privateDnsZoneGroup: {
          privateDnsZoneGroupConfigs: [
            {
              privateDnsZoneResourceId: privateDnsZone.outputs.resourceId
            }
          ]
        }
      }
    ]
    roleAssignments: concat(officerRoleAssignments, readOnlyRoleAssignments)
  }
}

@description('Resource ID of the Key Vault.')
output keyVaultResourceId string = keyVault.outputs.resourceId

@description('Name of the Key Vault.')
output keyVaultName string = keyVault.outputs.name

@description('URI of the Key Vault.')
output keyVaultUri string = keyVault.outputs.uri
