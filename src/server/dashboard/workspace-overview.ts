import 'server-only';
import type { PrismaClient } from '@/generated/prisma/client';
import { loadIntegrationDirectory } from './integrations';
import { listObservations } from './integration-observations';
import { observationWhere } from '@/lib/dashboard/observation-query';
export async function loadWorkspaceOverview(db:PrismaClient,workspaceId:string,now=new Date()){
 const since=new Date(now.getTime()-24*60*60*1000),window={gte:since,lte:now};
 const [directory,calls,drift,contract,linkedFailed,recent,driftRows,contractRows]=await Promise.all([
 loadIntegrationDirectory(db,workspaceId),db.integrationObservation.count({where:{workspaceId,receivedAt:window}}),
 db.integrationObservation.count({where:{...observationWhere(workspaceId,{page:1,finding:'drift'}),receivedAt:window}}),
 db.integrationObservation.count({where:{...observationWhere(workspaceId,{page:1,finding:'contract'}),receivedAt:window}}),
 db.integrationWorkflowOutcome.count({where:{workspaceId,outcome:'FAILED',receivedAt:window,observationLinks:{some:{workspaceId}}}}),
 listObservations(db,workspaceId,{page:1}),listObservations(db,workspaceId,{page:1,finding:'drift'}),listObservations(db,workspaceId,{page:1,finding:'contract'})]);
 const findings=[...driftRows.rows,...contractRows.rows].filter(r=>r.state==='DRIFT'||r.state==='CONTRACT_MISMATCH').sort((a,b)=>b.receivedAt.localeCompare(a.receivedAt)).slice(0,5);
 return {directory,calls,drift,contract,linkedFailed,recent,findings,now:now.toISOString(),since:since.toISOString()};
}
