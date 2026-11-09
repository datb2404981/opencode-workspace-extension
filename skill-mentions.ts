import type { Context } from '@opencode/plugin/tui/context'
import type { TextareaRenderable } from '@opentui/core'

// Let OpenCode own completion, the virtual mention and prompt.skills together.
// A plain text chip or a hidden staged file would not have native deletion semantics.
export function openNativeSkills(editor:TextareaRenderable, query='') {
  const prefix=editor.getTextRange(0,editor.cursorOffset)
  const separator=prefix&&!/\s$/u.test(prefix)?' ':''
  editor.focus()
  editor.insertText(separator+'@'+query)
}

function hasMention(editor:TextareaRenderable,id:string) {
  return editor.extmarks.getAll().some(mark=>mark.virtual&&editor.getTextRange(mark.start,mark.end)==='@'+id)
}

// One-time upgrade of the old file-based skill chips. Use the public native
// autocomplete command so both the input token and its skill payload are created.
export async function restoreNativeSkill(context:Context, editor:TextareaRenderable, id:string, alive:()=>boolean) {
  if(hasMention(editor,id))return true
  if(!alive()||!id||/\s/u.test(id))return false
  const original=editor.plainText,cursor=editor.cursorOffset
  editor.gotoBufferEnd()
  const start=editor.cursorOffset
  openNativeSkills(editor,id)
  const inserted=editor.plainText
  for(let attempt=0;attempt<30;attempt++){
    if(!alive()||editor.plainText!==inserted)return false
    const select=context.keymap.commands().find(command=>command.id==='prompt.autocomplete.select')
    if(select){
      // Search settles after the content-change callback; never choose a stale result.
      await new Promise(resolve=>setTimeout(resolve,20))
      if(!alive()||editor.plainText!==inserted)return false
      context.keymap.dispatch('prompt.autocomplete.select')
      if(hasMention(editor,id)){editor.cursorOffset=cursor;return true}
      break
    }
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  // Keep the original staged skill if native completion could not register it.
  // Undo only our exact insertion, preserving existing mentions and subsequent typing.
  if(alive()&&editor.plainText===inserted){
    editor.cursorOffset=start;const from=editor.logicalCursor
    editor.gotoBufferEnd();const to=editor.logicalCursor
    editor.deleteRange(from.row,from.col,to.row,to.col)
    if(editor.plainText===original)editor.cursorOffset=cursor
    context.keymap.dispatch('prompt.autocomplete.hide')
  }
  return false
}
