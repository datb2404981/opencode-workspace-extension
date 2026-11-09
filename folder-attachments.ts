import path from 'node:path'
import { readdir, realpath } from 'node:fs/promises'
import { ROOT_KEY, isInside } from './workspace-core.ts'

export const ACTIVE_FOLDERS = 'localAttachedFolders'
export const FOLDER_RULES = 'localAttachedFolderRules'
export const ADMITTED_FOLDERS = 'localAttachmentFolderPaths'
const ignored = new Set(['.git','.ssh','.aws','node_modules','vendor','.venv','venv','__pycache__','.cache','.next','dist','build','coverage','target','.DS_Store'])
export function sensitivePath(file: string) {
  const parts=file.split(path.sep), name=path.basename(file)
  return parts.some(p=>['.git','.ssh','.aws'].includes(p)) ||
    (name==='.env'||name.startsWith('.env.'))&&name!=='.env.example' ||
    ['id_rsa','id_ed25519','credentials.json'].includes(name)
}
export async function scanFolder(input: string) {
  const root=await realpath(input)
  if(sensitivePath(root))throw new Error('Không đính kèm folder cấu hình nhạy cảm')
  const entries:string[]=[];let visited=0,skipped=0,truncated=false
  async function walk(dir:string,depth:number) {
    if(depth>12||visited>=2000||entries.length>=300){truncated=true;return}
    const children=await readdir(dir,{withFileTypes:true})
    children.sort((a,b)=>a.name.localeCompare(b.name,'vi'))
    for(const item of children){
      if(++visited>2000||entries.length>=300){truncated=true;return}
      const full=path.join(dir,item.name)
      if(ignored.has(item.name)||sensitivePath(full)||item.isSymbolicLink()){skipped++;continue}
      const relative=path.relative(root,full)
      if(item.isDirectory()){
        entries.push(relative+'/')
        try{await walk(full,depth+1)}catch{skipped++}
      }else if(item.isFile())entries.push(relative)
    }
  }
  await walk(root,0)
  return {entries,skipped,truncated,preview:entries.join('\n')}
}
export function attachedFolders(metadata:Record<string,any>|undefined):string[] {
  const values=metadata?.[ACTIVE_FOLDERS]
  return Array.isArray(values)?[...new Set(values.filter((p:any)=>typeof p==='string'&&path.isAbsolute(p)&&path.dirname(p)!==p&&!p.includes('\0')))]:[]
}
type Rule={action:string;resource:string;effect:'allow'|'deny'|'ask'}
const same=(a:Rule,b:Rule)=>a.action===b.action&&a.resource===b.resource&&a.effect===b.effect
// Only remove rules created by this feature; preserve pre-existing user permissions.
export function folderAccess(session:any, roots:string[]) {
  roots=roots.filter(root=>path.isAbsolute(root)&&path.dirname(root)!==root)
  const metadata=session.metadata??{},rules:Rule[]=[...(session.permissions??[])]
  for(const owned of metadata[FOLDER_RULES]??[]){
    const index=rules.findIndex(r=>same(r,owned));if(index>=0)rules.splice(index,1)
  }
  const workspace=metadata[ROOT_KEY]??session.location.directory, added:Rule[]=[]
  for(const root of roots){
    if(isInside(workspace,root))continue
    for(const alias of new Set([root,root.normalize('NFC'),root.normalize('NFD')])){
      for(const resource of [alias,path.join(alias,'*')]){
        const rule:Rule={action:'external_directory',resource,effect:'allow'}
        if(!rules.some(r=>same(r,rule))){rules.push(rule);added.push(rule)}
      }
    }
  }
  return {metadata:{...metadata,[ACTIVE_FOLDERS]:roots,[FOLDER_RULES]:added},permissions:rules}
}
