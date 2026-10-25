// The live environment in rg-studiodesk. The image tag and the admin token come from the shell, so neither
// is stored here: IMAGE=ghcr.io/guepe99/studio-desk:<sha> ADMIN_TOKEN=<token> \
//   az deployment group create -g rg-studiodesk -p infra/rg-studiodesk.bicepparam
using 'main.bicep'

param image = readEnvironmentVariable('IMAGE')
param adminToken = readEnvironmentVariable('ADMIN_TOKEN')
// The two role assignments were made with the az CLI before this template described them.
param roleAssignmentNames = {
  openAiUser: '2df303a0-8a97-493e-bcab-003f317cf7a3'
  safetyUser: '02a45cd1-1cea-4642-9575-5ccb3a517851'
}
