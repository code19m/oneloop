// @ts-check

/**
 * Contracts at the compatibility boundary. Canonical field mapping belongs to
 * projection-store; new feature code should extend these types, not add globals.
 * @typedef {ReturnType<import('./api-client.js').createApiClient>} ApiClient
 * @typedef {ReturnType<import('./command-gateway.js').createCommandGateway>} CommandGateway
 * @typedef {ReturnType<import('./projection-store.js').createLegacyData>} LegacyData
 * @typedef {{view:string,projectId?:string,taskId?:string,modal?:any,board?:any,poolTab?:string}} LegacyContext
 * @typedef {{context:()=>LegacyContext,refresh:()=>void,toast:(message:string,kind?:string)=>void} & Record<string,any>} LegacyApp
 * The remaining dynamic renderer methods are migration exceptions covered by
 * the strict diagnostic/lint baselines until their feature is extracted.
 */
export {};
