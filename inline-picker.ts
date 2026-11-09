import type { Context } from '@opencode/plugin/tui/context'
import type { InputRenderable, MouseEvent } from '@opentui/core'
import { jsx } from '@opentui/solid/jsx-runtime'
import { createEffect, createMemo, createRoot, createSignal, onCleanup } from 'solid-js'

type Option<T> = { title:string; description?:string; value:T }
type Selection<T> = { title:string; options?:Option<T>[]; load?:()=>Promise<Option<T>[]>; query?:string }

// One compact, focus-scoped picker shared by skills and slash commands.
// It lives in the composer footer; opening it never changes or submits the draft.
export function createInlinePicker(context:Context, focusPrompt:()=>void) {
  const [opened,setOpened]=createSignal(false),[title,setTitle]=createSignal(''),[query,setQuery]=createSignal('')
  const [options,setOptions]=createSignal<Option<any>[]>([]),[selected,setSelected]=createSignal(0)
  const [loading,setLoading]=createSignal(false),[error,setError]=createSignal('')
  let search:InputRenderable|undefined,resolve:((value:any)=>void)|undefined,request=0,disposed=false
  let owner:string|undefined
  const current=()=>{const route=context.ui.router.current();return route.type==='session'?route.sessionID:undefined}
  const normalize=(text:string)=>text.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase()
  const normalized=new WeakMap<Option<any>,string>()
  let stopFiltering=()=>{}
  const filtered=createRoot(dispose=>{
    stopFiltering=dispose
    return createMemo(()=>{
      const terms=normalize(query()).trim().split(/[\s_-]+/).filter(Boolean)
      return options().filter(option=>{
        let text=normalized.get(option)
        if(text===undefined){text=normalize(option.title+' '+(option.description??''));normalized.set(option,text)}
        return terms.every(term=>text.includes(term))
      })
    })
  })
  const count=()=>Math.min(6,Math.max(2,Math.floor((context.renderer.height-8)/2)))
  const start=()=>Math.floor(selected()/count())*count()
  const row=(index:number)=>filtered()[start()+index]
  const finish=(value?:any,focus=true)=>{
    request++;setOpened(false)
    const done=resolve;resolve=undefined;done?.(value)
    if(focus&&current()===owner)focusPrompt()
  }
  const deferFinish=(value?:any)=>{
    const generation=request
    // Leave native key dispatch before changing the reactive layer or focus.
    queueMicrotask(()=>{if(!disposed&&opened()&&generation===request)finish(value)})
  }
  const pick=()=>{const option=filtered()[selected()];if(option&&!loading())deferFinish(option.value)}
  const move=(delta:number)=>{const length=filtered().length;setSelected(i=>Math.max(0,Math.min(length-1,i+delta)))}
  context.keymap.layer(()=>({mode:'global',priority:100,target:()=>search,
    enabled:!disposed&&opened(),
    commands:[
      {id:'local.inline.up',bind:'up',run:()=>move(-1)},
      {id:'local.inline.down',bind:'down',run:()=>move(1)},
      {id:'local.inline.pageup',bind:'pageup',run:()=>move(-count())},
      {id:'local.inline.pagedown',bind:'pagedown',run:()=>move(count())},
      {id:'local.inline.select',bind:'return',run:pick},
      {id:'local.inline.tab',bind:'tab',run:pick},
      {id:'local.inline.close',bind:'escape',run:()=>deferFinish()},
    ],bindings:['local.inline.up','local.inline.down','local.inline.pageup','local.inline.pagedown','local.inline.select','local.inline.tab','local.inline.close'],
  }))
  const select=async<T,>(input:Selection<T>):Promise<T|undefined>=>{
    if(disposed)return
    finish(undefined,false)
    owner=current();setTitle(input.title);setOptions(input.options??[]);setQuery(input.query??'');setSelected(0);setError('')
    setLoading(Boolean(input.load));setOpened(true)
    const generation=request
    const result=new Promise<T|undefined>(done=>{resolve=done})
    if(input.load)void input.load().then(items=>{
      if(disposed||generation!==request)return
      // A catalog can merge global and project skill sources. Keep one entry per name.
      const seen=new Set<string>();setOptions(items.filter(item=>{
        if(seen.has(item.title))return false
        seen.add(item.title);return true
      }))
      setLoading(false)
    }).catch(reason=>{if(generation===request&&!disposed){setLoading(false);setError(reason?.message??String(reason))}})
    return result
  }
  const render=(input:{readonly sessionID?:string;readonly mode:string})=>{
    createEffect(()=>{if(opened()&&(input.mode!=='normal'||input.sessionID!==owner))finish(undefined,false)})
    createEffect(()=>{
      if(!opened())return
      const initial=query()
      // Search owns its own text. Later query updates must not reset the cursor.
      if(search&&context.renderer.currentFocusedRenderable!==search){
        search.value=initial;search.gotoBufferEnd();search.focus()
      }
    })
    onCleanup(()=>{search=undefined;if(opened())finish(undefined,false)})
    const chooseRow=(index:number)=>{
      let pressed=false
      return {onMouseDown:(event:MouseEvent)=>{pressed=event.button===0;if(pressed){event.stopPropagation();setSelected(start()+index)}},
        onMouseDrag:()=>{pressed=false},onMouseUp:(event:MouseEvent)=>{if(pressed&&event.button===0&&!event.isDragging){event.stopPropagation();pick()}pressed=false}}
    }
    return jsx('box',{id:'local-inline-picker',flexDirection:'column',flexShrink:0,paddingLeft:1,paddingRight:1,
      get visible(){return opened()&&input.mode==='normal'},
      onMouseDown:(event:MouseEvent)=>event.stopPropagation(),children:[
        jsx('text',{get fg(){return context.theme.text.base},get children(){return title()+' · '+(loading()?'Đang tải…':filtered().length+' kết quả')}}),
        jsx('input',{id:'local-inline-search',ref:(value:InputRenderable)=>{search=value},width:'100%',placeholder:'Gõ để tìm…',get cursorColor(){return context.theme.text.base},
          get textColor(){return context.theme.text.base},get focusedTextColor(){return context.theme.text.base},
          onMouseDown:(event:MouseEvent)=>{event.stopPropagation();search?.focus()},
          onKeyDown:(event:any)=>{
            if(event.defaultPrevented||event.ctrl||event.meta||event.super||event.option)return
            const actions:Record<string,()=>void>={up:()=>move(-1),down:()=>move(1),pageup:()=>move(-count()),pagedown:()=>move(count()),
              return:pick,enter:pick,tab:pick,escape:()=>deferFinish()}
            const run=actions[event.name]
            if(run){event.preventDefault();event.stopPropagation();run()}
          },
          onInput:(value:string)=>{setQuery(value);setSelected(0)}}),
        ...Array.from({length:6},(_,index)=>jsx('text',{height:1,truncate:true,selectable:false,
          get visible(){return index<count()&&Boolean(row(index))},
          get fg(){return context.theme.text.base},
          get bg(){return start()+index===selected()?'#e2e0da':undefined},
          get children(){return (start()+index===selected()?'› ':'  ')+(row(index)?.title??'')},...chooseRow(index)})),
        jsx('text',{height:1,truncate:true,get fg(){return context.theme.text.muted},get children(){
          return error()||(!loading()&&!filtered().length?'Không tìm thấy mục phù hợp. Thử từ khóa khác.':filtered()[selected()]?.description?.replace(/\s+/g,' ')??'')
        }}),
        jsx('text',{height:1,get fg(){return context.theme.text.muted},get children(){
          const length=filtered().length;return `↑↓ chọn · Enter/Tab dùng · Esc đóng${length?' · '+(selected()+1)+'/'+length:''}`
        }}),
      ]})
  }
  return {select,render,close:()=>finish(),dispose:()=>{disposed=true;finish(undefined,false);stopFiltering()}}
}
