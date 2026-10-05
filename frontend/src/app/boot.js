// @ts-check

import { createBuildMonitor } from './build-info.js';
import { showStartupError } from './main.js';

import { createApiClient, ApiError } from '../data/api-client.js';
import { createBootstrapController } from '../data/bootstrap-controller.js';
import { createCommandGateway } from '../data/command-gateway.js';
import { createLegacyData } from '../data/projection-store.js';
import { createAuthController } from '../auth/auth-controller.js';
import { authorizationReturnTarget } from '../auth/oauth-return.js';
import { installViewBridge } from './view-bridge.js';
import { installViewEventOwner } from './view-events.js';
import { createRuntimeHooks } from './runtime-hooks.js';
import { actionErrorFeedback } from './action-feedback.js';
import { presentFormError } from './form-feedback.js';
import { createReadController } from '../data/read-controller.js';
import { installAttachmentTransport } from '../features/attachments/attachment-transport.js';
import { installCollaborationController } from '../features/collaboration/controller.js';
import { installKnowledgeController } from '../features/knowledge/controller.js';
import { createRecoveryController } from '../features/recovery/controller.js';
import { createProjectionReload, routeScope as scopeOfRoute } from './projection-reload.js';

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
globalThis.OneloopErrorMessage=(error,fallback='The request could not be completed.')=>{
  const feedback=actionErrorFeedback(error);return feedback.silent?'':feedback.message||fallback;
};
const bootstrap = createBootstrapController({ api, data, onReady: (projection) => runtimeHooks?.publish({ type:'bootstrap', projection }), onError: (error) => {
  if(error instanceof ApiError&&(error.code==='network_error'||error.status===401))return;
  if(error instanceof ApiError&&[403,404].includes(error.status))return;
  reportError(error);
} });
const gateway = createCommandGateway({ api, data, getScope:()=>`${data.session?.userId??''}:${data.session?.id??''}`,onChange: (result) => runtimeHooks?.publish({ type:'command', result }),onPending:(key,pending)=>recovery?.interactionPending(key,pending) });
// A read repaints only the view that shows what it loaded.
const reads = createReadController({api,data,onBoard:()=>app?.context?.().view==='board'?app.refreshBoard():app?.refreshCounts(),onRoadmap:()=>app?.refreshRoadmap(),onPool:()=>app?.refreshPool(),onTask:(task)=>{const context=app?.context?.();if(context?.view==='task'&&context.taskId===task.id)app.refresh();},onEpic:()=>app?.refreshEpic(),onCounts:()=>app?.refreshCounts(),onError:()=>{}});
const reloadProjection = createProjectionReload({data,bootstrap,reads,getApp:()=>app,getBridge:()=>bridge,getRecovery:()=>recovery});
const routeScope = () => scopeOfRoute(location.hash, app);
runtimeHooks = createRuntimeHooks({ api, gateway, data, reload: reloadProjection });
runtimeHooks = installAttachmentTransport(runtimeHooks);
globalThis.OneloopTransport = runtimeHooks;
installCollaborationController({transport:runtimeHooks});
installKnowledgeController({runtime:runtimeHooks,getApp:()=>app});

const auth = createAuthController({
  api, data,
  refresh: () => app?.refresh(),
  loadBootstrap: async () => {
    const scope=routeScope();
    try{return await bootstrap.load(scope);}
    catch(error){
      if(scope.taskId&&error instanceof ApiError&&[403,404].includes(error.status))return bootstrap.load({view:'metadata'});
      throw error;
    }
  },
  reportError,
  invalidate:()=>{bootstrap.cancel();reads.cancel();gateway.invalidate();},
  onSessionChange:(session)=>{
    runtimeHooks?.publish({type:'auth',session});
    recovery?.sessionChanged(session);
    if(session&&!session.temporary&&pendingAuthorization){const target=pendingAuthorization;pendingAuthorization=null;location.replace(target);return;}
    if(session)queueMicrotask(()=>routeLoader({reuseBootstrap:true}));
  },
});

recovery=createRecoveryController({data,api,gateway,getApp:()=>app,getAuth:()=>auth,reload:reloadProjection});
globalThis.OneloopRecovery=recovery;
globalThis.Recovery=recovery;

installViewEventOwner(document.documentElement);

const buildMonitor=createBuildMonitor({
  fetchBuild:async()=>{
    const response=await fetch('/healthz',{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(5000)});
    return response.ok?response.json():null;
  },
  onInitial:value=>{globalThis.ONELOOP_BUILD=Object.freeze({version:value.version,build:value.revision});},
  onUpdate:()=>recovery.buildChanged(),
});
runtimeHooks.subscribe(change=>{
  const boardChanged=change.type==='sse'&&change.kind!=='inbox.changed'&&!['comment','attachment','knowledge_source'].includes(change.entityType)
    ||change.type==='command'&&change.result?.entities?.some((/** @type {{entityType?:string}} */ entity)=>['project','membership','track','epic','milestone','task','taskBlock','poolItem'].includes(entity.entityType));
  if(boardChanged&&app?.context?.().view!=='board')reads.invalidateBoard();
  if(change.type==='live-open')void buildMonitor.check();
});

try {
  void buildMonitor.check();
  await Promise.all([auth.initialize(),loadViewDependencies()]);
  globalThis.ONELOOP_DEFER_BOOT_RENDER=true;
  await loadClassic('/views/app.js');
  app = globalThis.App;
  if (!app) throw new Error('The web client did not initialize.');
  bridge = installViewBridge({app,data,gateway,auth,api,reads,recovery,reloadBootstrap:(scope=routeScope())=>bootstrap.load({...routeScope(),...scope})});
  globalThis.OneloopRuntime = Object.freeze({ ...bridge, transport:runtimeHooks, now:api.serverNow });
  app.refresh();
  routeLoader=async(options={})=>{try{await bridge.loadCurrentRoute(options);}catch(error){if(!recovery.handleRouteError(error))reportError(error);}};
  window.addEventListener('hashchange',routeLoader);
  await routeLoader({reuseBootstrap:true});
} catch (error) {
  showStartupError(error);
}

async function loadViewDependencies() {
  await Promise.all([
    '/views/motion.js','/vendor/js-sha256/sha256.js','/views/activity.js',
    '/views/file-views.js','/views/uploads.js','/views/collaboration.js',
  ].map(loadClassic));
}

function loadClassic(source) {
  return new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=new URL(`../../${source.replace(/^\//,'')}`,import.meta.url).href;script.async=false;
    const fail=()=>{clearTimeout(timer);script.remove();reject(new Error(`Could not load ${source}`));};
    const timer=setTimeout(fail,30_000);
    script.addEventListener('load',()=>{clearTimeout(timer);resolve();},{once:true});
    script.addEventListener('error',fail,{once:true});
    document.head.append(script);
  });
}
