// Bounded foreground-first admission shared by playback, downloads and caption conversion.
export function createConversionAdmission({limit=4,maxQueued=16}={}) {
  let active=0;const queue=[];
  function pump() {
    while(active<limit && queue.length) {
      const index=queue.findIndex(item=>item.foreground),item=queue.splice(index<0?0:index,1)[0];
      item.signal?.removeEventListener('abort',item.abort);active++;
      let released=false;
      item.resolve(()=>{if(!released){released=true;active--;pump();}});
    }
  }
  return {
    acquire({foreground=true,signal}={}) {
      if(signal?.aborted)return Promise.reject(signal.reason);
      if(queue.length>=maxQueued)return Promise.reject(Object.assign(new Error('Playback conversion queue is full. Try again shortly.'),{code:'PLAYBACK_BUSY'}));
      return new Promise((resolve,reject)=>{
        const item={foreground,signal,resolve,reject};
        item.abort=()=>{const index=queue.indexOf(item);if(index>=0)queue.splice(index,1);reject(signal.reason);};
        signal?.addEventListener('abort',item.abort,{once:true});queue.push(item);pump();
      });
    },
    stats:()=>({active,queued:queue.length,limit})
  };
}
export const conversionAdmission=createConversionAdmission();
