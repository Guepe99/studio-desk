// Application Insights for the agents' OpenTelemetry traces (studiodesk/telemetry.py), on a Log Analytics
// workspace. Pay-as-you-go: the first 5 GB a month are free; both daily caps stop ingestion at 0.1 GB a day.
// Deploy alone: az deployment group create -g rg-studiodesk -f infra/monitoring.bicep
param location string = resourceGroup().location
param workspaceName string = 'log-studiodesk'
param insightsName string = 'studiodesk-insights'
param dailyCapGb string = '0.1'

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json(dailyCapGb) }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: insightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    DisableIpMasking: false // client addresses are never stored
  }
}

resource cap 'Microsoft.Insights/components/pricingPlans@2017-10-01' = {
  parent: insights
  name: 'current'
  properties: {
    planType: 'Basic'
    cap: json(dailyCapGb)
    stopSendNotificationWhenHitCap: false
    stopSendNotificationWhenHitThreshold: false
    warningThreshold: 90
  }
}

output insightsName string = insights.name
