'use strict'
const params=new URLSearchParams(location.search)
let id=params.get('id') || params.get('tabId'), serial=0
const args=()=>id?{id}:{}
const error=(e)=>{document.getElementById('reader-status').textContent='';document.getElementById('reader-error').textContent=e.message || String(e)}
const node=(tag,text)=>{const el=document.createElement(tag);el.textContent=text || '';return el}
async function load() {
  const own=++serial
  try {
    const result=await skiff.call('reader.get',args())
    if(own!==serial)return
    id=result.id || id
    document.getElementById('reader-error').textContent=''
    if(!result.active||!result.article) {
      document.getElementById('article').replaceChildren()
      document.getElementById('reader-status').textContent='Reader is closed. Return to the page and open Reader again.'
      return
    }
    const article=result.article
    const elements=[node('h1',article.title),node('p',[article.byline,article.siteName].filter(Boolean).join(' · '))]
    for(const block of article.blocks || [{type:'paragraph',text:article.text}])elements.push(node(block.type==='heading'?`h${Math.min(6,Math.max(2,(block.level || 1)+1))}`:block.type==='pre'?'pre':block.type==='quote'?'blockquote':'p',block.text))
    document.getElementById('article').replaceChildren(...elements)
    document.getElementById('reader-status').textContent=''
    document.getElementById('article').focus({preventScroll:true})
  } catch(e) { if(own===serial)error(e) }
}
async function close(){try{++serial;await skiff.call('reader.close',args());await skiff.call('ui.closeTools')}catch(e){error(e)}}
document.getElementById('reader-close').addEventListener('click',close)
document.addEventListener('keydown',(event)=>{if(event.key==='Escape'){event.preventDefault();close()}})
skiff.on('reader-open',(data)=>{id=data?.id || id;load()})
skiff.on('page-reader',(data)=>{if(data?.id===id&&!data.active&&!data.loading){++serial;document.getElementById('article').replaceChildren();document.getElementById('reader-status').textContent='The page changed. Return to the page and open Reader again.'}})
load()
