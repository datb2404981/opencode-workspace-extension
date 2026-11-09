import { TextareaRenderable, InputRenderable } from '@opentui/core'
import type { CliRenderer, Renderable, MouseEvent } from '@opentui/core'

function textareas(root:Renderable, found:TextareaRenderable[]=[]):TextareaRenderable[] {
  if(root.isDestroyed||!root.visible)return found
  if(root instanceof TextareaRenderable&&!(root instanceof InputRenderable))found.push(root)
  for(const child of root.getChildren())textareas(child,found)
  return found
}
// Bind only the composer containing our footer, never the whole application's mouse handling.
export function bindPromptFocus(renderer:CliRenderer, footer:Renderable, cursorColor:()=>TextareaRenderable['cursorColor']) {
  let owner=footer.parent,editor:TextareaRenderable|undefined
  while(owner&&owner!==renderer.root){
    const candidates=textareas(owner)
    if(candidates.length>1){owner=null;break}
    editor=candidates[0];if(editor)break;owner=owner.parent
  }
  const focus=()=>{
    const candidates=owner&&owner!==renderer.root?textareas(owner):[]
    const target=candidates.length===1?candidates[0]:undefined
    if(target&&!target.isDestroyed&&target.focusable&&target.visible){target.cursorColor=cursorColor();target.focus();return true}
    return false
  }
  if(!owner||owner===renderer.root)return{editor:()=>undefined as TextareaRenderable|undefined,focus:()=>false,dispose:()=>{}}
  const container=owner, previous=container.processMouseEvent
  const syncCursorColor=()=>{const list=textareas(container);if(list.length===1)list[0].cursorColor=cursorColor()}
  const colorTimer=setTimeout(syncCursorColor,0)
  editor?.on('focused',syncCursorColor)
  const wrapper=function(this:Renderable,event:MouseEvent){
    if(event.type==='down'&&event.button===0&&!event.defaultPrevented)focus()
    previous.call(this,event)
  }
  container.processMouseEvent=wrapper
  return {editor:()=>{const list=textareas(container);return list.length===1?list[0]:undefined},focus,dispose:()=>{clearTimeout(colorTimer);editor?.off('focused',syncCursorColor);if(container.processMouseEvent===wrapper)container.processMouseEvent=previous}}
}
