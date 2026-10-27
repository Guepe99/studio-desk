// The live environment in rg-studiodesk. The image tag and the admin token come from the shell, so neither
// is stored here: IMAGE=ghcr.io/guepe99/studio-desk:<sha> ADMIN_TOKEN=<token> \
//   az deployment group create -g rg-studiodesk -p infra/rg-studiodesk.bicepparam
using 'main.bicep'

param image = readEnvironmentVariable('IMAGE')
param adminToken = readEnvironmentVariable('ADMIN_TOKEN')
// The OpenAI role assignment was made with the az CLI before this template described it. The Content Safety
// one (Azure AI Developer) gets a guid() name. Today the live container still uses the earlier Cognitive Services
// User assignment on the account, 02a45cd1-1cea-4642-9575-5ccb3a517851, made with the az CLI; a deployment of this
// template adds the narrower role, and the earlier one is then deleted by hand.
param roleAssignmentNames = {
  openAiUser: '2df303a0-8a97-493e-bcab-003f317cf7a3'
  speechUser: 'a1cb9f70-4711-496e-b41a-0fd87a85933c'
}
// The live Content Safety account reports no customSubDomainName; its endpoint is
// https://studiodesk-safety-e2606.cognitiveservices.azure.com/. Empty keeps the property out of the request.
param safetySubdomain = ''
// Speech gets its custom subdomain with the first deployment that has this line (checked free on 27 Oct 2026);
// it is permanent. The app's Speech User assignment was made with the Azure CLI on 27 Oct 2026.
param speechSubdomain = 'studiodesk-speech-e2606'
