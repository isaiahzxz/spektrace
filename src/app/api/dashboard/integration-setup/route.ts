import { z } from "zod";
import { allowLocalDashboard,readSetupJson } from "@/lib/http/local-dashboard";
import { getPrisma } from "@/lib/db";
import { requestWorkspace } from "@/server/accounts/workspace";
import { listPlanned,savePlanned,saveIntegrationSetup } from "@/server/accounts/planned-integrations";
export async function GET(request:Request){if(!allowLocalDashboard(request))return new Response(null,{status:404});try{const db=getPrisma(),ws=await requestWorkspace(request,db);return Response.json({integrations:await listPlanned(db,ws)},{headers:{'cache-control':'no-store'}});}catch{return Response.json({error:'Sign in or check setup storage.'},{status:401});}}
export async function POST(request:Request){if(!allowLocalDashboard(request,true))return new Response(null,{status:403});try{const db=getPrisma(),ws=await requestWorkspace(request,db),body=z.object({action:z.enum(['add','configure']),data:z.unknown()}).strict().parse(await readSetupJson(request,16384));return Response.json(await(body.action==='add'?savePlanned(db,ws,body.data):saveIntegrationSetup(db,ws,body.data)));}catch{return Response.json({error:'Setup could not be saved. Check labels and sign-in.'},{status:400});}}
