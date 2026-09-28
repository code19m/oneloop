// @ts-check

/** Compare the running client with the server again after each live reconnect. */
export function createBuildMonitor({fetchBuild, onInitial, onUpdate}) {
  let initial=null,pending=null,changed=false;
  async function check(){
    if(pending)return pending;
    pending=(async()=>{
      try{
        const value=await fetchBuild();
        if(!value||typeof value.version!=='string'||typeof value.revision!=='string')return;
        if(!initial){initial=value;onInitial(value);return;}
        if(!changed&&(value.version!==initial.version||value.revision!==initial.revision)){
          changed=true;onUpdate(value);
        }
      }catch{} // API connectivity owns outage feedback; keep the last known build.
      finally{pending=null;}
    })();
    return pending;
  }
  return {check};
}
