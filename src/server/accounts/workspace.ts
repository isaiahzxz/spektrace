import { safeReturnTo } from "@/lib/accounts/return-to";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { PrismaClient } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db";
import { requirePilotWorkspaceId } from "@/lib/internal-config";
import { accountMode,getAccountAuth } from "./auth";
export async function accountWorkspace(db:PrismaClient,user:{id:string;name:string;emailVerified:boolean}){
 if(!user.emailVerified)throw Error('Verified account required');
 return db.$transaction(async tx=>{await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'account:'+user.id}))::text`;
 const rows=await tx.$queryRaw<{workspace_id:string}[]>`SELECT workspace_id FROM account_workspaces WHERE user_id=${user.id}`;if(rows[0])return rows[0].workspace_id;
 const workspace=await tx.workspace.create({data:{name:(user.name.slice(0,60)||'My')+' workspace',slug:'account-'+createHash('sha256').update(user.id).digest('hex')}});
 await tx.$executeRaw`INSERT INTO account_workspaces(user_id,workspace_id) VALUES(${user.id},${workspace.id}::uuid)`;return workspace.id;});
}
export async function requestWorkspace(request:Request,db:PrismaClient,readSession:(headers:Headers)=>Promise<{user:{id:string;name:string;emailVerified:boolean}}|null>=(headers)=>getAccountAuth().api.getSession({headers})){if(!accountMode())return requirePilotWorkspaceId();const session=await readSession(request.headers);if(!session?.user.emailVerified)throw Error('Sign in required');return accountWorkspace(db,session.user);}
export async function getDashboardWorkspaceId(returnTo?:string){if(!accountMode())return requirePilotWorkspaceId();const session=await getAccountAuth().api.getSession({headers:await headers()});if(!session?.user.emailVerified)redirect('/sign-in?next='+encodeURIComponent(safeReturnTo(returnTo)));return accountWorkspace(getPrisma(),session.user);}
