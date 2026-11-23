'use strict'
const divider=document.getElementById('divider')
let bounds=null, drag=null, pending=null, sending=false
function update(state){const split=state.splitBounds;if(split)bounds=split;else if(state.splitBySpace?.[state.activeSpaceId])bounds={...(bounds || {}),spaceId:state.activeSpaceId,...state.splitBySpace[state.activeSpaceId]};if(bounds)divider.setAttribute('aria-valuenow',String(Math.round(bounds.ratio*100)))}
async function resize(ratio){if(!bounds)return;pending=Math.max(.15,Math.min(.85,ratio));divider.setAttribute('aria-valuenow',String(Math.round(pending*100)));if(sending)return;sending=true;try{while(pending!=null){const value=pending;pending=null;await skiff.call('split.resize',{spaceId:bounds.spaceId,ratio:value});bounds.ratio=value}}catch(error){divider.setAttribute('aria-label',`Split resize failed: ${error.message}`)}finally{sending=false}}
divider.addEventListener('pointerdown',(event)=>{if(event.button!==0||!bounds?.width)return;event.preventDefault();drag={x:event.screenX,ratio:bounds.ratio,width:bounds.width};divider.setPointerCapture(event.pointerId);divider.focus()})
divider.addEventListener('pointermove',(event)=>{if(drag)resize(drag.ratio+(event.screenX-drag.x)/drag.width)})
divider.addEventListener('pointerup',()=>{drag=null})
divider.addEventListener('pointercancel',()=>{drag=null})
divider.addEventListener('keydown',(event)=>{if(!bounds)return;const step=event.shiftKey ? 0.1 : 0.02;if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();resize(bounds.ratio+(event.key==='ArrowLeft'?-step:step))}else if(event.key==='Home'||event.key==='End'){event.preventDefault();resize(event.key==='Home' ? 0.15 : 0.85)}else if(event.key==='Escape'){event.preventDefault();skiff.call('split.clear',{spaceId:bounds.spaceId}).catch((e)=>divider.setAttribute('aria-label',e.message))}})
skiff.on('state',update)
skiff.on('split-bounds',(data)=>update({splitBounds:data}))
skiff.call('state.get').then(update).catch((e)=>divider.setAttribute('aria-label',e.message))
