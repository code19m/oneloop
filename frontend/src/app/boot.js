// @ts-check

import { createBuildMonitor } from './build-info.js';
import { showStartupError } from './main.js';

import { createApiClient, ApiError } from '../data/api-client.js';
import { createBootstrapController } from '../data/bootstrap-controller.js';
import { createCommandGateway } from '../data/command-gateway.js';
import { createLegacyData, sessionKey } from '../data/projection-store.js';
import { createAuthController } from '../auth/auth-controller.js';
import { authorizationReturnTarget } from '../auth/oauth-return.js';
import { installViewBridge } from './view-bridge.js';
import { installViewActions } from './view-actions.js';
import { createRuntimeHooks } from './runtime-hooks.js';
import { actionErrorFeedback } from './action-feedback.js';
import { presentFormError } from './form-feedback.js';
import { createReadController } from '../data/read-controller.js';
import { installCollaborationController } from '../features/collaboration/controller.js';
import { installKnowledgeController } from '../features/knowledge/controller.js';
import { createRecoveryController } from '../features/recovery/controller.js';
import { createProjectionReload, createSignInLoad, routeScope as scopeOfRoute } from './projection-reload.js';
import { installTrustedTypes } from './trusted-types.js';
import { installTooltips } from './tooltips.js';
import { installSaveShortcut } from './save-shortcut.js';
import { installDisclosures } from './motion.js';
import { installPreviews } from '../features/files/preview.js';

installTrustedTypes();
// First, so actions run before the document's other listeners, as inline handlers did.
installViewActions(document);

const data = createLegacyData();
globalThis.DATA = data;
let pendingAuthorization = authorizationReturnTarget({search:location.search,origin:location.origin});

let recovery = null;
const api = createApiClient({
  getRequestContext:()=>recovery?.requestContext(),
  onResponse:(event)=>recovery?.observeResponse(event),
});
let app = null;
let bridge = null;
let runtimeHooks = null;
let routeLoader = async (_options={}) => {};
const reportError = (error, form = null) => {
  const feedback=actionErrorFeedback(error);
  if(feedback.silent)return;
  if(presentFormError(form,error,app))return;
  if (app) app.toast(feedback.message || 'The request could not be completed.', 'error');
  else showStartupError(error);
};
// A Board filter that names a value the loaded project lacks, such as a deleted
// track, is dropped before any read sends it.
const bootstrap = createBootstrapController({ api, data, onReady: (projection) => { app?.keepKnownFilters(); runtimeHooks?.publish({ type:'bootstrap', projection }); }, onError: (error) => {
  if(error instanceof ApiError&&(error.code==='network_error'||error.status===401))return;
  if(error instanceof ApiError&&[403,404].includes(error.status))return;
  reportError(error);
}, onForeign:(userId)=>recovery?.ownsAnswer(userId) });
const gateway = createCommandGateway({ api, data, getScope:()=>sessionKey(data),onChange: (result) => runtimeHooks?.publish({ type:'command', result }),onPending:(key,pending)=>recovery?.interactionPending(key,pending) });
// A read repaints only the view that shows what it loaded.
const reads = createReadController({api,data,onBoard:()=>app?.context?.().view==='board'?app.refreshBoard():app?.refreshCounts(),onRoadmap:()=>app?.refreshRoadmap(),onPool:()=>app?.refreshPool(),onTask:(task)=>{const context=app?.context?.();if(context?.view==='task'&&context.taskId===task.id)app.refresh();},onEpic:()=>app?.refreshEpic(),onCounts:()=>app?.refreshCounts(),onError:()=>{}});
const reloadProjection = createProjectionReload({data,bootstrap,reads,getApp:()=>app,getBridge:()=>bridge,getRecovery:()=>recovery});
const signInLoad = createSignInLoad({bootstrap,api,data,getApp:()=>app});
const routeScope = () => scopeOfRoute(location.hash, app);
runtimeHooks = createRuntimeHooks({ api, gateway, data, reload: reloadProjection });

const auth = createAuthController({
  api, data,
  refresh: () => app?.refresh(),
  loadBootstrap: () => signInLoad.load(),
  reportError,
  getApp: () => app,
  invalidate:()=>{bootstrap.cancel();reads.cancel();gateway.invalidate();},
  onSessionChange:(session)=>{
    signInLoad.sessionChanged();
    runtimeHooks?.publish({type:'auth',session});
    recovery?.sessionChanged(session);
    if(session&&!session.temporary&&pendingAuthorization){const target=pendingAuthorization;pendingAuthorization=null;location.replace(target);return;}
    if(session&&!session.temporary)app?.resolveRoute();
    if(session)queueMicrotask(()=>routeLoader({reuseBootstrap:true}));
  },
});

const buildMonitor=createBuildMonitor({
  fetchBuild:async()=>{
    const response=await fetch('/healthz',{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(5000)});
    return response.ok?response.json():null;
  },
  onInitial:value=>{globalThis.ONELOOP_BUILD=Object.freeze({version:value.version});},
  onUpdate:(value)=>recovery?.buildChanged(value),
});
recovery=createRecoveryController({data,api,gateway,getApp:()=>app,getAuth:()=>auth,reload:reloadProjection,checkBuild:()=>buildMonitor.check()});
globalThis.Recovery=recovery;
installCollaborationController({transport:runtimeHooks,recovery});
installKnowledgeController({runtime:runtimeHooks,getApp:()=>app});

installTooltips(document);
installSaveShortcut(document,recovery);
installDisclosures(document);
installPreviews(document,runtimeHooks);

runtimeHooks.subscribe(change=>{
  const boardChanged=change.type==='sse'&&change.kind!=='inbox.changed'&&!['comment','attachment','knowledge_source'].includes(change.entityType)
    ||change.type==='command'&&change.result?.entities?.some((/** @type {{entityType?:string}} */ entity)=>['project','membership','track','epic','milestone','task','taskBlock','poolItem'].includes(entity.entityType));
  if(boardChanged&&app?.context?.().view!=='board')reads.invalidateBoard();
  if(change.type==='live-open')void buildMonitor.check();
});

try {
  void buildMonitor.check();
  signInLoad.prefetch();
  await auth.initialize();
  ({ App: app } = await import('../../views/app.js'));
  recovery.start();
  bridge = installViewBridge({app,data,gateway,auth,api,reads,recovery,reloadBootstrap:(scope={})=>bootstrap.load({...routeScope(),...scope})});
  globalThis.OneloopRuntime = Object.freeze({ ...bridge, transport:runtimeHooks, now:api.serverNow });
  app.refresh();
  routeLoader=async(options={})=>{try{await bridge.loadCurrentRoute(options);}catch(error){if(!recovery.handleRouteError(error))reportError(error);}};
  window.addEventListener('hashchange',routeLoader);
  await routeLoader({reuseBootstrap:true});
} catch (error) {
  showStartupError(error);
}
