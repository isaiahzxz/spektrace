import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { requireDatabaseUrl } from "@/lib/env";
import { sendAccountMail } from "./mail";
export function accountMode(){return process.env.SPEKTRACE_ACCOUNTS_ENABLED==='true';}
export function authCapabilities(){return {enabled:accountMode(),ready:!!process.env.BETTER_AUTH_SECRET&&!!process.env.BETTER_AUTH_URL,email:!!process.env.SPEKTRACE_EMAIL_API_KEY&&!!process.env.SPEKTRACE_EMAIL_FROM,google:!!process.env.GOOGLE_CLIENT_ID&&!!process.env.GOOGLE_CLIENT_SECRET};}
export function createAccountAuth(pool:Pool,mail=sendAccountMail){
 const secret=process.env.BETTER_AUTH_SECRET,baseURL=process.env.BETTER_AUTH_URL;if(!secret||secret.length<32||!baseURL)throw Error('Account configuration incomplete');
 const origin=new URL(baseURL);if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname))))throw Error('Invalid account origin');
 return betterAuth({appName:'SpekTrace',database:pool,secret,baseURL:origin.origin,trustedOrigins:[origin.origin],user:{modelName:'auth_user'},session:{modelName:'auth_session'},account:{modelName:'auth_account',accountLinking:{enabled:false}},verification:{modelName:'auth_verification'},
 emailAndPassword:{enabled:true,minPasswordLength:12,requireEmailVerification:true,sendResetPassword:async({user,url})=>{await mail(user.email,'Reset your SpekTrace password',url);}},
 emailVerification:{sendOnSignUp:true,sendOnSignIn:true,autoSignInAfterVerification:true,sendVerificationEmail:async({user,url})=>{await mail(user.email,'Verify your SpekTrace email',url);}},
 socialProviders:process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET?{google:{clientId:process.env.GOOGLE_CLIENT_ID,clientSecret:process.env.GOOGLE_CLIENT_SECRET}}:{},rateLimit:{enabled:true,window:60,max:20},logger:{disabled:true},telemetry:{enabled:false}});
}
let instance:ReturnType<typeof createAccountAuth>|undefined;
export function getAccountAuth(){if(!accountMode())throw Error('Accounts are not enabled');return instance??=createAccountAuth(new Pool({connectionString:requireDatabaseUrl(),max:5}));}
