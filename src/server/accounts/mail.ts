export async function sendAccountMail(to:string,subject:string,text:string){
 const token=process.env.SPEKTRACE_EMAIL_API_KEY,from=process.env.SPEKTRACE_EMAIL_FROM;if(!token||!from)throw Error('Email delivery is not configured');
 const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({from,to:[to],subject,text}),redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!response.ok){await response.body?.cancel();throw Error('Email delivery failed');}await response.body?.cancel();
}
