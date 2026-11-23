'use strict'
const params = new URLSearchParams(location.search)
let id = params.get('id') || params.get('tabId'), composing = false, serial = 0
const query = document.getElementById('find-query'), matchCase = document.getElementById('find-case')
const error = (e) => {document.getElementById('find-error').textContent=e.message || String(e)}
const args = () => id ? {id} : {}
function draw(result) {if(!result || (id&&result.id!==id))return;id=result.id || id;document.getElementById('find-count').textContent=result.count?`${result.current || 0} of ${result.count}`:'0 matches'}
async function update() {if(composing)return;const request=++serial;try{const result=await skiff.call('find.update',{...args(),query:query.value,matchCase:matchCase.checked});if(request===serial)draw(result)}catch(e){if(request===serial)error(e)}}
async function next(forward=true){if(composing)return;try{draw(await skiff.call('find.next',{...args(),forward}))}catch(e){error(e)}}
async function close(){try{await skiff.call('find.close',args());await skiff.call('ui.closeTools')}catch(e){error(e)}}
query.addEventListener('compositionstart',()=>{composing=true})
query.addEventListener('compositionend',()=>{composing=false;update()})
query.addEventListener('input',(event)=>{if(!event.isComposing)update()})
matchCase.addEventListener('change',update)
document.getElementById('find-form').addEventListener('submit',(event)=>{event.preventDefault();next()})
document.getElementById('find-previous').addEventListener('click',()=>next(false))
document.getElementById('find-close').addEventListener('click',close)
document.addEventListener('keydown',(event)=>{if(event.isComposing||event.keyCode===229||composing)return;if(event.key==='Escape'){event.preventDefault();close()}else if(event.key==='Enter'&&event.shiftKey){event.preventDefault();next(false)}})
skiff.on('page-find',draw)
skiff.on('find-open',(data)=>{id=data?.id || id;if(data?.query!=null)query.value=data.query;query.focus();query.select()})
skiff.call('find.open',args()).then((result)=>{draw(result);query.value=result.query || '';matchCase.checked=Boolean(result.matchCase);query.focus();query.select()}).catch(error)
