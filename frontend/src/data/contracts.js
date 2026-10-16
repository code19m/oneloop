// @ts-check

/**
 * Types at the boundary between src/ and the views. wire.js maps statuses,
 * scopes and mentions, and projection-store maps the other fields. The
 * window globals are listed in frontend/README.md.
 * @typedef {ReturnType<import('./api-client.js').createApiClient>} ApiClient
 * @typedef {ReturnType<import('./command-gateway.js').createCommandGateway>} CommandGateway
 * @typedef {ReturnType<import('./projection-store.js').createLegacyData>} LegacyData
 * @typedef {{view:string,projectId?:string,taskId?:string,modal?:any,board?:any,poolTab?:string,peek?:string|null,movePending?:boolean}} LegacyContext
 * @typedef {(...args:any[])=>any} ViewMethod
 */
/**
 * `App`, the views' actions and refresh methods. These are the ones src/
 * calls; the view bridge adds the server-backed ones.
 * @typedef {{
 *   context:()=>LegacyContext, refresh:()=>void, toast:(message:string,kind?:string,options?:{action?:{label:string,run:()=>void}})=>void,
 *   acceptMoreBoard:ViewMethod, acceptMoreUsers:ViewMethod, askToDiscard:ViewMethod, clearAddress:ViewMethod,
 *   clearTaskSaving:ViewMethod, closeOverlays:ViewMethod, commentDraft:ViewMethod, confirm:ViewMethod, fieldError:ViewMethod,
 *   followAddress:ViewMethod, isRendering:ViewMethod, keepKnownFilters:ViewMethod, nav:ViewMethod, noteTaskSaved:ViewMethod, noteTaskSaving:ViewMethod,
 *   offerUndo:ViewMethod, openModal:ViewMethod, openPeek:ViewMethod, openTask:ViewMethod, prepareBlock:ViewMethod,
 *   redrawDialog:ViewMethod, refreshAfterDialog:ViewMethod, refreshBackground:ViewMethod, refreshBoard:ViewMethod,
 *   refreshCounts:ViewMethod, refreshEpic:ViewMethod, refreshPool:ViewMethod, refreshProfileAccess:ViewMethod,
 *   refreshRoadmap:ViewMethod, refreshTaskDrafts:ViewMethod, refreshTaskHeader:ViewMethod, refreshUsers:ViewMethod,
 *   resolveRoute:ViewMethod, restoreCommentDraft:ViewMethod, selectProject:ViewMethod, showBlocked:ViewMethod, showTemporaryPassword:ViewMethod,
 *   signOutText:ViewMethod, togglePoolDescription:ViewMethod, updateDocumentTitle:ViewMethod, validateFormDates:ViewMethod,
 * } & Record<string,unknown>} LegacyApp
 */
export {};
