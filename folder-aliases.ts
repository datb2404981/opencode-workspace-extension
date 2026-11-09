import path from 'node:path'
import {createHash} from 'node:crypto'

// Stable across chat turns, folder order changes and NFC/NFD macOS spelling.
// A revoked folder's alias stops resolving; it never shifts to a different folder.
export function folderAliases(roots:string[]) {
  return roots.map(root=>({root,name:path.basename(root),
    alias:'@folder/'+createHash('sha256').update(root.normalize('NFC')).digest('hex').slice(0,8)}))
}
export function resolveFolderAlias(input:string,roots:string[]) {
  if(!input.startsWith('@folder/'))return
  const match=/^(@folder\/[a-f0-9]{8})(?:\/(.*))?$/.exec(input)
  const choices=match?folderAliases(roots).filter(item=>item.alias===match[1]):[]
  if(choices.length!==1)throw new Error('Alias folder không hợp lệ hoặc folder chưa được gắn trong chat này')
  return {root:choices[0].root,target:path.resolve(choices[0].root,match?.[2]??'.')}
}
