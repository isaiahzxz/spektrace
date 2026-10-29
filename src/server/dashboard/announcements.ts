import "server-only";
import { readFile,mkdir,writeFile,rename,unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { accountMode,getAccountAuth } from '@/server/accounts/auth';
import { announcementSchema,emptyAnnouncement,type Announcement } from '@/lib/dashboard/announcement';
const filename=()=>process.env.SPEKTRACE_ANNOUNCEMENTS_FILE??path.join(process.cwd(),'work','platform-announcements.json');
export async function readAnnouncement(file=filename()):Promise<{announcement:Announcement;available:boolean}>{try{const text=await readFile(file,'utf8');if(Buffer.byteLength(text)>8192)throw Error('Announcement limit');return {announcement:announcementSchema.parse(JSON.parse(text)),available:true};}catch(e){return {announcement:emptyAnnouncement,available:!!e&&typeof e==='object'&&'code' in e&&e.code==='ENOENT'};}}
export async function writeAnnouncement(input:unknown,file=filename()){const value=announcementSchema.parse(input);await mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temp,file);}finally{await unlink(temp).catch(()=>{});}return value;}
export function isPlatformOwner(userId:string){const owner=(process.env.SPEKTRACE_PLATFORM_OWNER_ID??'').trim();return !!owner&&owner===userId;}
export async function canEditAnnouncements(requestHeaders?:Headers,readSession:(headers:Headers)=>Promise<{user:{id:string;emailVerified:boolean}}|null>=(h)=>getAccountAuth().api.getSession({headers:h})){if(!accountMode())return false;const session=await readSession(requestHeaders??await headers());return !!session?.user.emailVerified&&isPlatformOwner(session.user.id);}
