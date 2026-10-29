import { getAccountAuth,authCapabilities } from "@/server/accounts/auth";
async function handle(request:Request){const c=authCapabilities();if(!c.enabled||!c.ready)return Response.json({error:'Account sign-in is not configured on this server.'},{status:503});try{return await getAccountAuth().handler(request);}catch{return Response.json({error:'Account request unavailable'},{status:503});}}
export const GET=handle;export const POST=handle;
