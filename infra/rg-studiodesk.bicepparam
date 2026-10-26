// The live environment in rg-studiodesk. The image tag and the admin token come from the shell, so neither
// is stored here: IMAGE=ghcr.io/guepe99/studio-desk:<sha> ADMIN_TOKEN=<token> \
//   az deployment group create -g rg-studiodesk -p infra/rg-studiodesk.bicepparam
using 'main.bicep'

param image = readEnvironmentVariable('IMAGE')
param adminToken = readEnvironmentVariable('ADMIN_TOKEN')
// The OpenAI role assignment was made with the az CLI before this template described it. The Content Safety
// one (Azure AI Developer) gets a guid() name; the earlier Cognitive Services User assignment on the account,
// 02a45cd1-1cea-4642-9575-5ccb3a517851, is not removed by a deployment and is deleted by hand once the new one works.
param roleAssignmentNames = {
  openAiUser: '2df303a0-8a97-493e-bcab-003f317cf7a3'
}
// The live Content Safety account was made without a custom subdomain and Azure generated its endpoint
// (studiodesk-safety-e2606); setting one now would change that endpoint, and it could never be removed.
param safetySubdomain = ''
