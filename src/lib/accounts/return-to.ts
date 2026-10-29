export function safeReturnTo(value:string|undefined){return value&&/^\/(?:dashboard(?:\/[A-Za-z0-9_/-]*)?|alerts\/(?:[a-f0-9-]{36}|preview))$/.test(value)?value:'/dashboard/onboarding';}
