// The Container App as it runs on Azure (one replica, consumption plan, system identity for Foundry and
// Content Safety), plus Application Insights (monitoring.bicep). The environment cae-studiodesk exists already.
// az deployment group create -g rg-studiodesk -f infra/main.bicep -p image=ghcr.io/guepe99/studio-desk:<sha> adminToken=<token>
param location string = resourceGroup().location
param image string
@secure()
param adminToken string
param openAiEndpoint string = 'https://studiodesk-ai-89965b.openai.azure.com'
param contentSafetyEndpoint string = 'https://studiodesk-safety-e2606.cognitiveservices.azure.com'

var insightsName = 'studiodesk-insights'

module monitoring 'monitoring.bicep' = {
  name: 'monitoring'
  params: { location: location, insightsName: insightsName }
}

resource insights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: insightsName
  dependsOn: [monitoring]
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: 'cae-studiodesk'
}

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
            { name: 'AZURE_OPENAI_ENDPOINT', value: openAiEndpoint }
            { name: 'AZURE_OPENAI_DEPLOYMENT', value: 'gpt-5-mini' }
            { name: 'ADMIN_TOKEN', secretRef: 'admin-token' }
            { name: 'AZURE_CONTENT_SAFETY_ENDPOINT', value: contentSafetyEndpoint }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'appinsights-connection-string' }
          ]
        }
      ]
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
}
