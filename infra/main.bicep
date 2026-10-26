// Everything Studio Desk runs on in its resource group: the Foundry account and project with the gpt-5-mini
// deployment, Content Safety, Speech, the Container Apps environment and app, the app identity's roles, and
// Application Insights (monitoring.bicep). How to deploy it, here or from scratch: README, Deployment.
param location string = resourceGroup().location
param image string
@secure()
param adminToken string
// The account name is also its custom subdomain (<name>.openai.azure.com), unique across Azure: pick a new
// one for a fresh environment.
param aiName string = 'studiodesk-ai-89965b'
// Role assignment names (GUIDs) that already exist, by role; a fresh environment leaves this empty and gets
// guid() names. Role assignment names are unique in the tenant, so they cannot be reused elsewhere.
param roleAssignmentNames object = {}
// Content Safety's custom subdomain (<name>.cognitiveservices.azure.com): Entra ID tokens need one, regional
// endpoints refuse them. Unique across Azure and permanent once set. Empty: no subdomain, for an account made
// without one, whose endpoint Azure generated (the live one, rg-studiodesk.bicepparam).
param safetySubdomain string = 'studiodesk-safety-${uniqueString(resourceGroup().id)}'

var insightsName = 'studiodesk-insights'
var openAiUser = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd' // Cognitive Services OpenAI User
// Azure AI Developer: the Content Safety data actions (text:analyze, text:shieldprompt) without
// accounts/listkeys/action, which Cognitive Services User also grants. Its other permissions are on Machine
// Learning workspaces and other kinds of account, so they reach nothing at the scope of this account.
// https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/ai-machine-learning#azure-ai-developer
var azureAiDeveloper = '64702f94-c441-49e6-a78b-ef80e0188fee'

module monitoring 'monitoring.bicep' = {
  name: 'monitoring'
  params: { location: location, insightsName: insightsName }
}

resource insights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: insightsName
  dependsOn: [monitoring]
}

// Microsoft Foundry: the agents and Ask the studio call gpt-5-mini through the Responses API with Entra ID
// tokens only (studiodesk/agents/llm.py, studiodesk/api.py). Keys stay enabled because they are on now; the
// code never reads them, so disableLocalAuth: true would remove them without a code change.
resource ai 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: aiName
  location: location
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: aiName
    allowProjectManagement: true
    defaultProject: 'studiodesk'
    publicNetworkAccess: 'Enabled'
  }
}

// The Foundry project, used for the evaluations (README, Limits).
resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: ai
  name: 'studiodesk'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {}
}

resource model 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: ai
  name: 'gpt-5-mini' // studiodesk/config.py MODEL_DEPLOYMENT
  sku: { name: 'GlobalStandard', capacity: 100 } // 100k tokens and 100 requests a minute
  properties: {
    model: { format: 'OpenAI', name: 'gpt-5-mini', version: '2025-08-07' }
    versionUpgradeOption: 'NoAutoUpgrade' // a new model version only by a change here, never under the app
    raiPolicyName: 'Microsoft.DefaultV2'
  }
  dependsOn: [project] // one change at a time on the account
}

// Content Safety on the free tier (one F0 account per kind per subscription). The container calls it with its
// managed identity (Azure AI Developer below). studiodesk/agents/safety.py falls back to key1 through the
// az CLI when Entra ID is refused, which only works on a machine with az; dropping that fallback (_use_key)
// would let this account set disableLocalAuth: true.
resource safety 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: 'studiodesk-safety'
  location: location
  kind: 'ContentSafety'
  sku: { name: 'F0' }
  properties: {
    customSubDomainName: empty(safetySubdomain) ? null : safetySubdomain
    publicNetworkAccess: 'Enabled'
  }
}

// Speech on the free tier, used only offline by studiodesk/voice.py to record the replay voice-over; the
// container never calls it, so the app identity has no role here. voice.py reads key1 through the az CLI
// because the account has no custom subdomain, which Entra ID tokens need. To remove the key: add
// customSubDomainName (permanent, it cannot be removed), give the person who records the voice
// 'Cognitive Services Speech User', and change voice.py to send a bearer token to the subdomain endpoint.
resource speech 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: 'studiodesk-speech'
  location: location
  kind: 'SpeechServices'
  sku: { name: 'F0' }
  properties: { publicNetworkAccess: 'Enabled' }
}

// Consumption only, no log destination: the app's traces go to Application Insights.
resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-studiodesk'
  location: location
  properties: {
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    zoneRedundant: false
  }
}

// The Content Safety host: the custom subdomain, or the one Azure generated (studiodesk-safety-e2606 on the live
// account); the app wants it with no trailing slash.
var safetyEndpoint = 'https://${split(safety.properties.endpoint, '/')[2]}'

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'studiodesk'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 8000, transport: 'auto', allowInsecure: false }
      secrets: [
        { name: 'admin-token', value: adminToken }
        { name: 'appinsights-connection-string', value: insights.properties.ConnectionString }
      ]
    }
    template: {
      containers: [
        {
          name: 'studiodesk'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'AZURE_OPENAI_ENDPOINT', value: 'https://${aiName}.openai.azure.com' }
            { name: 'AZURE_OPENAI_DEPLOYMENT', value: model.name }
            { name: 'ADMIN_TOKEN', secretRef: 'admin-token' }
            { name: 'AZURE_CONTENT_SAFETY_ENDPOINT', value: safetyEndpoint }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'appinsights-connection-string' }
          ]
        }
      ]
      // one replica always on: the desk's caps and runtime.sqlite live in it and reset when it scales to zero
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

resource appOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: ai
  name: roleAssignmentNames.?openAiUser ?? guid(ai.id, app.id, openAiUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', openAiUser)
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource appSafetyUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: safety
  name: roleAssignmentNames.?safetyDeveloper ?? guid(safety.id, app.id, azureAiDeveloper)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', azureAiDeveloper)
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}
