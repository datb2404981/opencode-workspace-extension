import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { TextareaRenderable, decodePasteBytes } from '@opentui/core'
import type { PasteEvent, MouseEvent } from '@opentui/core'
import type { Context } from '@opencode/plugin/tui/context'
import { jsx } from '@opentui/solid/jsx-runtime'
import { createEffect, createSignal, onCleanup } from 'solid-js'
import { ROOT_KEY, folderPermissions } from './workspace-core.ts'
import { PENDING_FILES, pendingFiles, parseFilePaths, droppedFilesNow, validatePickedFiles } from './attachments-core.ts'
import { registerIDEDrops, type PromptDraft } from './attachments-ide.ts'
import { attachedFolders, folderAccess, scanFolder } from './folder-attachments.ts'
import { bindPromptFocus } from './prompt-focus.ts'
import { registerInlineCommands } from './inline-commands.ts'
import { createInlinePicker } from './inline-picker.ts'
import { openNativeSkills, restoreNativeSkill } from './skill-mentions.ts'
import { SessionActivity } from './session-activity.ts'

type PickerMode = 'mixed' | 'files' | 'folders' | 'project'

export async function macFilePicker(directory: string, mode: PickerMode = 'mixed'): Promise<string[]> {
  if (process.platform !== 'darwin') throw new Error('Hộp chọn tệp này dành cho macOS; dùng /tep /đường/dẫn/tệp')
  const executable = fileURLToPath(new URL('./OpenCodeFilePicker.app/Contents/MacOS/OpenCodeFilePicker', import.meta.url))
  return new Promise((resolve,reject)=>{
    const proc=spawn(executable,['--directory',directory,'--mode',mode],{stdio:['ignore','pipe','pipe']})
    let result='',errors=''
    proc.stdout.on('data',data=>{result+=data;if(result.length>256*1024)proc.kill()})
    proc.stderr.on('data',data=>{errors+=data})
    proc.once('error',reject)
    proc.once('close',status=>{
      if(status!==0)return reject(new Error('Không mở được hộp chọn tệp macOS: '+errors.slice(-200)))
      try {const files=JSON.parse(result);if(!Array.isArray(files)||!files.every(f=>typeof f==='string'))throw new Error();resolve(files)}
      catch {reject(new Error('Hộp chọn tệp trả dữ liệu không hợp lệ'))}
    })
  })
}

export function registerAttachmentUI(context: Context, picker = macFilePicker) {
  let disposed=false, selecting=false, queue=Promise.resolve()
  const stageJobs=new Set<Promise<void>>()
  let prompt:{sessionID?:string;mode:'normal'|'shell'}|undefined
  let focusBinding:ReturnType<typeof bindPromptFocus>|undefined
  let createdFromHome:{id:string;editor?:TextareaRenderable}|undefined
  const focusPrompt=()=>{focusBinding?.focus()}
  const inlinePicker=createInlinePicker(context,focusPrompt)
  const isComposer=(editor:any):editor is TextareaRenderable=>editor instanceof TextareaRenderable&&focusBinding?.editor()===editor
  const notify=(error:any)=>context.ui.toast.show({message:error.message??String(error),variant:'error'})
  const activeID=()=>{const route=context.ui.router.current();return route.type==='session'?route.sessionID:undefined}
  const folder=()=>{const sid=activeID();return (sid?context.data.session.get(sid)?.location.directory:undefined)??context.location?.directory??context.data.location.default().directory}
  const ensureSession=async(draft?:PromptDraft)=>{
    const sid=activeID();if(sid)return sid
    const editor=focusBinding?.editor(),original=editor?.plainText??''
    if(editor?.extmarks.getAll().length)throw new Error('Ô nhập đang có nội dung đặc biệt; hãy gửi tin nhắn đầu tiên trước khi gắn thêm file/folder.')
    const saved=draft??{text:original,cursor:editor?.cursorOffset??0}
    const directory=folder(), selected=context.ui.model.current()
    const created=await context.client.session.create({agent:'ask',location:{directory},
      ...(selected?{model:{providerID:selected.providerID,id:selected.modelID}}:{}),
      title:path.basename(directory)+' · tệp đính kèm',metadata:{[ROOT_KEY]:directory},permissions:folderPermissions(directory)})
    await context.data.session.sync(created.id)
    context.ui.router.navigate({type:'session',sessionID:created.id})
    createdFromHome={id:created.id,editor}
    for(let i=0;i<100;i++){
      if(disposed||activeID()!==created.id)break
      const next=focusBinding?.editor()
      if(next&&prompt?.sessionID===created.id&&!next.isDestroyed){
        if(!next.plainText||next===editor&&next.plainText===original){
          next.replaceText(saved.text);next.cursorOffset=saved.cursor
        }
        focusPrompt();break
      }
      await new Promise(r=>setTimeout(r,5))
    }
    return created.id
  }
  const change=(sid:string,run:(current:any)=>Promise<any>)=>{
    const next=queue.then(async()=>{
      if(disposed)return
      const current=await context.client.session.get({sessionID:sid})
      const update=await run(current)
      if(disposed)return
      await context.client.session.update({sessionID:sid,...update})
      await context.data.session.sync(sid)
    })
    queue=next.catch(()=>{})
    return next
  }
  const stageFiles=async(paths:string[],sessionID?:string,draft?:PromptDraft)=>{
    if(!paths.length||disposed)return
    // Validate before creating a chat, and never send a model request here.
    const initial=activeID(),initialFolder=folder()
    await validatePickedFiles(paths)
    if(!sessionID&&(activeID()!==initial||folder()!==initialFolder))throw new Error('Chat đã thay đổi; hãy chọn lại tệp cho chat hiện tại')
    const sid=sessionID??await ensureSession(draft)
    await change(sid,async current=>({metadata:{...current.metadata,[PENDING_FILES]:await validatePickedFiles(paths,pendingFiles(current.metadata))}}))
    const list=pendingFiles(context.data.session.get(sid)?.metadata),folders=list.filter(f=>f.kind==='folder').length
    context.ui.toast.show({message:`${list.length-folders} tệp · ${folders} folder đang chọn · chưa gửi`,variant:'success',duration:1800})
  }
  const stage=(paths:string[],sessionID?:string,draft?:PromptDraft)=>{
    const job=stageFiles(paths,sessionID,draft);stageJobs.add(job)
    void job.finally(()=>stageJobs.delete(job)).catch(()=>{})
    return job
  }
  const clear=async(sid:string,id?:string)=>change(sid,async current=>({metadata:{...current.metadata,
    [PENDING_FILES]:id?pendingFiles(current.metadata).filter(f=>f.id!==id):[]}}))
  const choose=async(input?:string,mode: PickerMode = 'mixed')=>{
    if(selecting||disposed)return
    selecting=true
    // Capture the chat before opening a native dialog; selection cannot drift to another chat.
    const sid=activeID(), directory=folder(),startedEditor=focusBinding?.editor()
    try {
      const paths=input?.trim()?parseFilePaths(input):await picker(directory,mode)
      if(activeID()!==sid||!sid&&folder()!==directory)throw new Error('Chat đã thay đổi; hãy chọn lại tệp cho chat hiện tại')
      if(input?.trim()&&!paths.length)throw new Error('Hãy nhập đường dẫn đầy đủ hoặc chọn tệp từ Finder')
      await stage(paths,sid)
    }catch(error){notify(error)}finally{selecting=false;if(activeID()===sid&&focusBinding?.editor()===startedEditor)focusPrompt()}
  }
  const manage=async()=>{
    const sid=activeID();if(!sid)return
    const session=await context.client.session.get({sessionID:sid}), files=pendingFiles(session.metadata), folders=attachedFolders(session.metadata)
    if(!files.length&&!folders.length)return
    const id=await context.ui.dialog.select({title:'Tệp/folder đính kèm',
      options:[...(files.length?[{title:'Xóa tất cả mục đang chọn (chưa gửi)',value:'all'}]:[]),
        ...files.flatMap(f=>f.kind==='folder'?[{title:'Xem danh sách: '+f.name+'/',description:`${f.entries} mục${f.truncated?' (rút gọn)':''} · chưa gửi`,value:'preview:'+f.id},
          {title:'Bỏ folder đang chọn: '+f.name+'/',value:f.id}]:[{title:f.name,description:`${Math.ceil(f.size/1024)} KiB · Enter để bỏ tệp`,value:f.id}]),
        ...folders.flatMap(root=>[{title:'Xem folder đã gắn: '+path.basename(root)+'/',description:root,value:'active:'+root},
          {title:'Ngừng cho AI đọc folder: '+path.basename(root)+'/',description:'Giữ nguyên folder và file trên máy',value:'revoke:'+root}])
      ]})
    if(!id){focusPrompt();return}
    if(id.startsWith('preview:')){
      const item=files.find(f=>f.id===id.slice(8));if(item)await context.ui.dialog.alert({title:item.name+'/',message:item.preview||'(Folder trống)'})
    }else if(id.startsWith('active:')){
      const root=id.slice(7),summary=await scanFolder(root)
      await context.ui.dialog.alert({title:path.basename(root)+'/',message:summary.preview||'(Folder trống)'})
    }else if(id.startsWith('revoke:')){
      await change(sid,async current=>folderAccess(current,attachedFolders(current.metadata).filter(root=>root!==id.slice(7))))
    }else await clear(sid,id==='all'?undefined:id)
    focusPrompt()
  }

  let migrating=false
  const migrated=new Set<string>()
  const migrateSkills=async()=>{
    if(migrating||disposed||prompt?.mode!=='normal')return
    const sid=activeID(),editor=focusBinding?.editor()
    if(!sid||!editor||context.renderer.currentFocusedRenderable!==editor)return
    const old=pendingFiles(context.data.session.get(sid)?.metadata).filter(file=>file.name.startsWith('Skill: '))
    if(!old.length)return
    const key=sid+':'+old.map(file=>file.id).join(',')
    if(migrated.has(key))return
    migrating=true
    try{
      await context.data.location.skill.sync()
      const skills=context.data.location.skill.list()??[]
      const alive=()=>!disposed&&!editor.isDestroyed&&activeID()===sid&&focusBinding?.editor()===editor&&context.renderer.currentFocusedRenderable===editor
      if(!alive())return
      // Do not replace an unfinished command or file mention in the user's draft.
      const before=editor.getTextRange(0,editor.cursorOffset)
      if(/(?:^|\s)[@/]\S*$/u.test(before))return
      migrated.add(key)
      for(const file of old){
        const skill=skills.find(item=>item.name===file.name.slice(7)&&item.path.normalize('NFC')===file.path.normalize('NFC'))
        if(!skill||!alive())continue
        if(await restoreNativeSkill(context,editor,skill.id,alive))await clear(sid,file.id)
      }
    }finally{migrating=false}
  }

  const slot=context.ui.slot({before:'prompt.footer',render:input=>{
    const token={sessionID:input.sessionID,mode:input.mode}
    let localFocus:ReturnType<typeof bindPromptFocus>|undefined
    let watchedEditor:TextareaRenderable|undefined
    const onComposerFocus=()=>queueMicrotask(()=>void migrateSkills().catch(notify))
    createEffect(()=>{token.sessionID=input.sessionID;token.mode=input.mode;prompt=token})
    createEffect(()=>{
      const sid=input.sessionID
      if(sid&&pendingFiles(context.data.session.get(sid)?.metadata).some(file=>file.name.startsWith('Skill: ')))
        queueMicrotask(()=>void migrateSkills().catch(notify))
    })
    onCleanup(()=>{watchedEditor?.off('focused',onComposerFocus);localFocus?.dispose();if(focusBinding===localFocus)focusBinding=undefined;if(prompt===token)prompt=undefined})
    const files=()=>pendingFiles(input.sessionID?context.data.session.get(input.sessionID)?.metadata:undefined)
    const folders=()=>attachedFolders(input.sessionID?context.data.session.get(input.sessionID)?.metadata:undefined)
    const action=(run:()=>void)=>{
      let pressed=false
      return {onMouseDown:(e:MouseEvent)=>{pressed=e.button===0&&!e.modifiers.shift;if(pressed)e.stopPropagation()},
        onMouseDrag:()=>{pressed=false},
        onMouseUp:(e:MouseEvent)=>{const clicked=pressed&&e.button===0&&!e.isDragging;pressed=false;if(clicked){e.stopPropagation();run()}}}
    }
    const button=(label:()=>string,run:()=>void,visible=()=>true)=>{
      const [hovered,setHovered]=createSignal(false)
      return jsx('text',{selectable:false,flexShrink:0,
        get visible(){return visible()},
        get fg(){return context.theme.text.base},
        get bg(){return hovered()?context.theme.background.raised.base:undefined},
        get children(){return '['+label()+']'},
        onMouseOver:()=>setHovered(true),onMouseOut:()=>setHovered(false),
        ...action(run)})
    }
    return jsx('box',{ref:(box:any)=>queueMicrotask(()=>{
      if(disposed||box.isDestroyed)return
      localFocus=bindPromptFocus(context.renderer,box,()=>context.theme.text.base);focusBinding=localFocus
      watchedEditor=localFocus.editor();watchedEditor?.on('focused',onComposerFocus)
      void migrateSkills().catch(notify)
    }),flexDirection:'column',flexShrink:0,marginTop:1,
      get visible(){return input.mode==='normal'},children:[jsx('box',{paddingLeft:1,paddingRight:1,children:
        jsx(SessionActivity,{context,get sessionID(){return input.sessionID},get mode(){return input.mode}})}),
        jsx('box',{flexDirection:'row',gap:2,paddingLeft:1,paddingRight:1,children:[
        button(()=>'⊕ Tệp',()=>void choose(undefined,'files')),
        button(()=>'▱ Thư mục',()=>void choose(undefined,'folders')),
        button(()=>`Xem (${files().length+folders().length})`,
          ()=>void manage().catch(notify),()=>Boolean(files().length||folders().length)),
        jsx('text',{selectable:false,truncate:true,flexGrow:1,flexShrink:1,minWidth:0,
          get fg(){return context.theme.text.muted},get children(){
            const list=files(),active=folders()
            if(list.length)return list.map(f=>f.name+(f.kind==='folder'?'/':'')).join(' · ')
            if(active.length)return active.map(f=>path.basename(f)+'/').join(' · ')
            return '/tep · /thu-muc'
          }}),
      ]}),inlinePicker.render(input)]})
  }})
  const onPaste=(event:PasteEvent)=>{
    if(disposed||prompt?.mode!=='normal'||!isComposer(context.renderer.currentFocusedRenderable))return
    const paths=droppedFilesNow(decodePasteBytes(event.bytes))
    if(!paths.length)return
    const sid=prompt.sessionID
    event.preventDefault();event.stopPropagation()
    void stage(paths,sid).catch(notify)
  }
  context.renderer.keyInput.prependListener('paste',onPaste)
  const submitWithFiles=async()=>{
    const startedID=activeID(),startedEditor=context.renderer.currentFocusedRenderable
    if(!isComposer(startedEditor))return
    try { await ideDrops.flush(); await Promise.all([...stageJobs]); await queue } catch(error) {notify(error);return}
    const ownNewChat=!startedID&&createdFromHome?.editor===startedEditor&&createdFromHome?.id===activeID()
    if(disposed||activeID()!==startedID&&!ownNewChat||context.renderer.currentFocusedRenderable!==startedEditor&&!ownNewChat)return
    const editor=context.renderer.currentFocusedRenderable
    if(editor instanceof TextareaRenderable){
      if(!editor.plainText.trim())editor.insertText('Phân tích các tệp/folder đính kèm.')
      context.keymap.dispatch('prompt.submit')
    }
  }
  const ideDrops=registerIDEDrops({renderer:context.renderer,prompt:()=>prompt,stage,error:notify,
    submit:submitWithFiles,waiting:()=>stageJobs.size>0,isComposer})
  const stopInline=registerInlineCommands(context,()=>prompt?.mode==='normal'?focusBinding?.editor():undefined,
    input=>inlinePicker.select(input))
  const chooseSkill=async(query?:string)=>{
    inlinePicker.close()
    const sid=activeID(),directory=folder(),editor=focusBinding?.editor()
    if(!editor||prompt?.mode!=='normal')return
    focusPrompt()
    await migrateSkills()
    await context.data.location.skill.sync()
    if(disposed||activeID()!==sid||folder()!==directory||editor!==focusBinding?.editor()||!editor.focusable)return
    openNativeSkills(editor,query)
  }
  context.keymap.layer(()=>({mode:'global',priority:15,commands:[
    // Replace the built-in command by its stable ID, so slash completion has one entry.
    {id:'prompt.skills',title:'Skill · tìm và chọn hướng dẫn đã lưu',group:'Skill',palette:true,slash:{name:'skills'},run:input=>chooseSkill(input).catch(notify)},
    {id:'local.attach.pick',title:'Chọn tệp/folder đính kèm (macOS)',group:'Tệp đính kèm',palette:true,
      slash:{name:'tep',aliases:['attach'],arguments:true},bind:'ctrl+alt+a',run:input=>choose(input)},
    {id:'local.attach.folder',title:'Đính kèm folder vào câu hỏi',group:'Tệp đính kèm',palette:true,
      slash:{name:'thu-muc',arguments:true},run:input=>choose(input,'folders')},
    {id:'local.attach.manage',title:'Xem hoặc xóa tệp đã chọn',group:'Tệp đính kèm',palette:true,
      slash:{name:'tep-da-chon'},run:manage},
    {id:'local.prompt.focus',title:'Đưa con trỏ vào ô nhập câu hỏi',group:'Ô nhập',palette:true,
      bind:'ctrl+alt+i',run:focusPrompt},
  ],bindings:['local.attach.pick','local.prompt.focus']}))
  // Native OpenCode does not know about this staged row when checking an empty prompt.
  context.keymap.layer(()=>({mode:'global',priority:20,target:()=>focusBinding?.editor(),
    enabled:()=>{
      const editor=context.renderer.currentFocusedRenderable,sid=activeID()
      return prompt?.mode==='normal'&&isComposer(editor)&&
        (ideDrops.pending()||stageJobs.size>0||!editor.plainText.trim()&&Boolean(sid&&pendingFiles(context.data.session.get(sid)?.metadata).length))
    },commands:[{id:'local.attach.submit',title:'Gửi tệp đã chọn',bind:'return',run:submitWithFiles}],bindings:['local.attach.submit']}))
  return {choose,stage,manage,settled:()=>queue,
    navigationBlocker:()=>{
      const editor=focusBinding?.editor()
      if(editor&&(editor.plainText.trim()||editor.extmarks.getAll().length))return 'Hãy gửi hoặc xóa nội dung đang nhập trước khi chuyển dự án.'
      if(selecting||stageJobs.size||ideDrops.pending())return 'Đang xử lý tệp đính kèm; hãy hoàn tất trước khi chuyển dự án.'
      const sid=activeID()
      if(sid&&pendingFiles(context.data.session.get(sid)?.metadata).length)return 'Chat đang có tệp chưa gửi; hãy gửi hoặc xóa trước khi chuyển dự án.'
      return undefined
    },
    dispose:()=>{disposed=true;inlinePicker.dispose();stopInline();focusBinding?.dispose();ideDrops.dispose();context.renderer.keyInput.removeListener('paste',onPaste);slot()}}
}
