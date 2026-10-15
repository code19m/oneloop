// @ts-check

/**
 * The view bridge: it adds the server-backed `App` methods, such as
 * `saveTask`, and wraps a few of the views' own, such as `nav`. Each module
 * in bridge/ installs one feature's actions on a shared context; this one
 * builds that context and composes them.
 */

import { sessionKey } from '../data/projection-store.js';
import { installAccount } from './bridge/account.js';
import { createCommands } from './bridge/commands.js';
import { installPool } from './bridge/pool.js';
import { installProjects } from './bridge/projects.js';
import { installRoadmap } from './bridge/roadmap.js';
import { installRoute } from './bridge/route.js';
import { createSaves } from './bridge/saves.js';
import { installTasks } from './bridge/tasks.js';

/**
 * What every part of the bridge works with: the app and its services, record
 * lookups, and the views' own methods from before the bridge wrapped them.
 * @typedef {{
 *   app:import('../data/contracts.js').LegacyApp, data:import('../data/contracts.js').LegacyData,
 *   gateway:import('../data/contracts.js').CommandGateway, api:import('../data/contracts.js').ApiClient, auth:any, reads:any,
 *   recovery:ReturnType<typeof import('../features/recovery/controller.js').createRecoveryController>, reloadBootstrap:Function,
 *   task:(id:string)=>any, epic:(id:string)=>any, track:(id:string)=>any, milestone:(id:string)=>any, poolItem:(id:string)=>any,
 *   context:()=>import('../data/contracts.js').LegacyContext, sessionScope:()=>string,
 *   nav:Function, openPeek:Function, openModal:Function,
 * }} BridgeBase
 * @typedef {BridgeBase & ReturnType<typeof createCommands> & ReturnType<typeof createSaves>} BridgeContext
 */

/** @param {{app:import('../data/contracts.js').LegacyApp,data:import('../data/contracts.js').LegacyData,gateway:import('../data/contracts.js').CommandGateway,api:import('../data/contracts.js').ApiClient,auth:any,reads:any,recovery:ReturnType<typeof import('../features/recovery/controller.js').createRecoveryController>,reloadBootstrap:Function}} options */
export function installViewBridge({ app, data, gateway, auth, api, reads, recovery, reloadBootstrap }) {
  /** @type {BridgeBase} */
  const base = {
    app, data, gateway, auth, api, reads, recovery, reloadBootstrap,
    task: (id) => data.tasks.find((item) => item.id === id || item.internalId === id),
    epic: (id) => data.epics.find((item) => item.id === id),
    track: (id) => data.tracks.find((item) => item.id === id),
    milestone: (id) => data.milestones.find((item) => item.id === id),
    poolItem: (id) => data.pool.find((item) => item.id === id),
    context: () => app.context(),
    sessionScope: () => sessionKey(data),
    nav: app.nav.bind(app),
    openPeek: app.openPeek.bind(app),
    openModal: app.openModal.bind(app),
  };
  const commands = createCommands(base);
  /** @type {BridgeContext} */
  const ctx = { ...base, ...commands, ...createSaves({ ...base, ...commands }) };
  const account = installAccount(ctx);
  const tasks = installTasks(ctx);
  const roadmap = installRoadmap(ctx);
  const pool = installPool(ctx);
  installProjects(ctx);
  const route = installRoute(ctx, account);
  return Object.freeze({ ...tasks, ...roadmap, ...pool, ...route, report: commands.report });
}
