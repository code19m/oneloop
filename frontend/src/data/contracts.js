// @ts-check

/**
 * Types at the boundary between src/ and the views. Canonical field mapping
 * belongs to projection-store. The window globals are listed in
 * frontend/README.md; new feature code extends these types instead.
 * @typedef {ReturnType<import('./api-client.js').createApiClient>} ApiClient
 * @typedef {ReturnType<import('./command-gateway.js').createCommandGateway>} CommandGateway
 * @typedef {ReturnType<import('./projection-store.js').createLegacyData>} LegacyData
 * @typedef {{view:string,projectId?:string,taskId?:string,modal?:any,board?:any,poolTab?:string,peek?:string|null,movePending?:boolean}} LegacyContext
 * @typedef {{context:()=>LegacyContext,refresh:()=>void,toast:(message:string,kind?:string,options?:{action?:{label:string,run:()=>void}})=>void} & Record<string,any>} LegacyApp
 * LegacyApp names the methods most modules need. The view modules add the
 * rest at run time, so they stay untyped.
 */
export {};
