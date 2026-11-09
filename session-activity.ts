import type { Context } from '@opencode/plugin/tui/context'
import { jsx } from '@opentui/solid/jsx-runtime'
import { createEffect, createSignal, onCleanup } from 'solid-js'

const frames=['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']
const elapsed=(milliseconds:number)=>{
  const seconds=Math.max(0,Math.floor(milliseconds/1000))
  return String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0')
}

// Read the actual session state and stream events; never infer activity from an
// animation or start polling the provider just to animate the interface.
export function SessionActivity(props:{context:Context;readonly sessionID?:string;readonly mode:string}) {
  const {context}=props
  const [now,setNow]=createSignal(Date.now()),[frame,setFrame]=createSignal(0)
  const [phase,setPhase]=createSignal('Đang xử lý'),[fallbackStart,setFallbackStart]=createSignal(0)
  const [ended,setEnded]=createSignal<{id:string;outcome:'succeeded'|'failed'|'interrupted'}>()
  const info=()=>props.sessionID?context.data.session.get(props.sessionID):undefined
  const running=()=>Boolean(props.sessionID&&context.data.session.status?.(props.sessionID)==='running')
  createEffect(()=>{
    props.sessionID
    setEnded(undefined);setPhase('Đang xử lý')
  })
  createEffect(()=>{
    props.sessionID
    if(!running()||props.mode!=='normal')return
    setPhase('Đang xử lý');setFallbackStart(Date.now());setNow(Date.now());setFrame(0)
    const timer=setInterval(()=>{setNow(Date.now());setFrame(value=>(value+1)%frames.length)},120)
    onCleanup(()=>clearInterval(timer))
  })
  const stop=context.data.listen?.(({details:event})=>{
    if(!props.sessionID||!event.data||typeof event.data!=='object'||!('sessionID' in event.data)||event.data.sessionID!==props.sessionID)return
    const type=event.type
    if(type==='session.execution.started'){setEnded(undefined);setPhase('Đang chờ phản hồi')}
    else if(type==='session.reasoning.started'||type==='session.reasoning.delta')setPhase('Đang suy nghĩ')
    else if(type==='session.text.started'||type==='session.text.delta')setPhase('Đang trả lời')
    else if(type==='session.tool.input.started'||type==='session.tool.called')setPhase('Đang chạy công cụ')
    else if(type==='session.tool.success'||type==='session.tool.failed')setPhase('Đang xử lý')
    else if(type==='session.retry.scheduled')setPhase('Đang thử lại')
    else if(type==='session.compaction.started'||type==='session.compaction.delta')setPhase('Đang thu gọn ngữ cảnh')
    else if(type==='session.compaction.ended'||type==='session.compaction.failed')setPhase('Đang xử lý')
    else if(type==='session.execution.succeeded')setEnded({id:props.sessionID,outcome:'succeeded'})
    else if(type==='session.execution.failed')setEnded({id:props.sessionID,outcome:'failed'})
    else if(type==='session.execution.interrupted')setEnded({id:props.sessionID,outcome:'interrupted'})
  })
  onCleanup(()=>stop?.())
  const outcome=()=>ended()?.id===props.sessionID?ended()?.outcome:info()?.outcome
  const duration=()=>{
    const session=info(),start=session?.time?.busy??fallbackStart()
    const end=running()?now():session?.time?.idle
    return start&&end?elapsed(end-start):undefined
  }
  return jsx('text',{id:'local-session-activity',height:1,flexShrink:0,truncate:true,selectable:false,
    get fg(){return running()?context.theme.text.base:context.theme.text.muted},
    get children(){
      const time=duration(),suffix=time?' · '+time:''
      if(running())return frames[frame()]+' '+phase()+suffix
      if(outcome()==='failed')return '! Gặp lỗi'+suffix
      if(outcome()==='interrupted')return '■ Đã dừng'+suffix
      if(outcome()==='succeeded')return '✓ Đã xong'+suffix
      return '○ Sẵn sàng'
    }})
}
