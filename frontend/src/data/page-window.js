// @ts-check

/**
 * Replace the refreshed head (including removed/consolidated rows), retaining
 * only rows older than its boundary. An exhausted page is authoritative.
 * @template {{id:string, ts?:number}} T
 * @param {T[]} previous
 * @param {T[]} fresh
 * @param {boolean} hasMore
 * @param {(item:T)=>number} time
 * @param {number} [boundary] Oldest raw row, before hiding redundant UI events.
 * @returns {T[]}
 */
export function refreshPageWindow(previous, fresh, hasMore, time, boundary) {
  const oldest=boundary??fresh.reduce((value,item)=>Math.min(value,time(item)),Infinity);
  const byId=new Map((hasMore?previous.filter(item=>time(item)<=oldest):[]).map(item=>[item.id,item]));
  for(const item of fresh)byId.set(item.id,item);
  return [...byId.values()];
}
