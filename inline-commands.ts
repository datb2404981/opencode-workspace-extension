import type { Context } from '@opencode/plugin/tui/context'
import { TextareaRenderable } from '@opentui/core'

export function registerInlineCommands(context:Context, editor:()=>TextareaRenderable|undefined,
  select: (input:any)=>Promise<any> = input=>context.ui.dialog.select(input)) {
  let timer:ReturnType<typeof setTimeout>|undefined,disposed=false,opening=false
  const onKey=(event:any)=>{
    const input=editor()
    if(disposed||opening||!input||context.renderer.currentFocusedRenderable!==input||
      event.ctrl||event.meta||event.super||event.option||event.eventType==='release')return
    if(event.sequence!=='/'&&event.name!=='/')return
    const offset=input.cursorOffset,prefix=input.getTextRange(0,offset),suffix=input.getTextRange(offset,input.editBuffer.measureText(input.plainText))
    if(!prefix)return // Native autocomplete owns the start of the composer.
    if(timer)clearTimeout(timer)
    timer=setTimeout(()=>{void (async()=>{
      if(disposed||input.isDestroyed||context.renderer.currentFocusedRenderable!==input)return
      const text=input.plainText
      if(!text.startsWith(prefix)||!text.endsWith(suffix))return
      const token=text.slice(prefix.length,suffix.length?text.length-suffix.length:undefined)
      if(!/^\/[\p{L}\p{N}_-]*$/u.test(token))return // A dropped path/URL is not an inline command.
      const query=token.slice(1).toLowerCase()
      const commands=context.keymap.commands().filter(c=>c.slash)
      const server=context.data.location.command.list()??[]
      const options=[...commands.map(c=>({title:'/'+c.slash!.name,description:c.title,value:{type:'local',command:c}})),
        ...server.map(c=>({title:'/'+c.name,description:c.description,value:{type:'server',command:c}}))]
      if(!options.some(o=>!query||o.title.toLowerCase().includes(query)))return
      opening=true
      try{
        const selected=await select({title:'Tính năng',options,query})
        if(!selected||disposed||input.isDestroyed||input.plainText!==text)return
        let args:string|undefined
        if(selected.type==='local'&&selected.command.slash.arguments){
          args=await context.ui.dialog.prompt({title:selected.command.title??selected.command.slash.name,description:'Có thể để trống để mở bộ chọn.'})
          if(args===undefined)return
        }
        if(input.isDestroyed||input.plainText!==text)return
        const start=input.editBuffer.offsetToPosition(input.editBuffer.measureText(prefix)),end=input.editBuffer.offsetToPosition(input.editBuffer.measureText(prefix+token))
        if(!start||!end)return
        input.deleteRange(start.row,start.col,end.row,end.col)
        if(selected.type==='local')await selected.command.run(args)
        else {
          const rest=input.plainText;input.gotoBufferHome();input.insertText('/'+selected.command.name+' ')
          input.cursorOffset=input.editBuffer.measureText('/'+selected.command.name+' '+rest)
        }
      }finally{opening=false;if(!disposed&&editor()===input&&!input.isDestroyed&&input.focusable)input.focus()}
    })().catch(error=>context.ui.toast.show({message:String(error),variant:'error'}))},150)
  }
  context.renderer.keyInput.prependListener('keypress',onKey)
  return()=>{disposed=true;if(timer)clearTimeout(timer);context.renderer.keyInput.removeListener('keypress',onKey)}
}
