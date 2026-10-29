export function allowLocalDashboard(request:Request,write=false){
 if(process.env.SPEKTRACE_ACCOUNTS_ENABLED==='true'){try{const base=new URL(process.env.BETTER_AUTH_URL??''),u=new URL(request.url);return (u.host===base.host||request.headers.get('host')===base.host)&&(!write||request.headers.get('origin')===base.origin);}catch{return false;}}
 const u=new URL(request.url),allowed=['localhost','127.0.0.1','[::1]'];
 if(process.env.NODE_ENV!=='development'||!allowed.includes(u.hostname))return false;
 if(!write)return true;
 try{const origin=new URL(request.headers.get('origin')??'');return allowed.includes(origin.hostname)&&origin.protocol===u.protocol&&origin.port===u.port&&!origin.username&&!origin.password;}catch{return false;}
}
export async function readSetupJson(request: Request,maxBytes=2048) {
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') || request.headers.has('content-encoding'))
        throw Error('JSON required');
    const reader = request.body?.getReader();
    if (!reader)
        throw Error('Body required');
    let size = 0;
    const chunks: Uint8Array[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => { }); reject(Error('Body deadline')); }, 2000); });
    try {
        while (true) {
            const part = await Promise.race([reader.read(), timeout]);
            if (part.done)
                break;
            size += part.value.byteLength;
            if (size > maxBytes) {
                void reader.cancel().catch(() => { });
                throw Error('Body limit');
            }
            chunks.push(part.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    }
    finally {
        if (timer)
            clearTimeout(timer);
        try {
            reader.releaseLock();
        }
        catch { }
    }
}
