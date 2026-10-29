import "dotenv/config";
async function main() {
    const base = new URL(process.env.SPEKTRACE_STATUS_ORIGIN ?? 'http://127.0.0.1:3000');
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))))
        throw Error();
    const token = process.env.SPEKTRACE_INTERNAL_API_TOKEN;
    if (!token)
        throw Error();
    const response = await fetch(new URL('/api/internal/integration-status', base), { headers: { authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok)
        throw Error();
    const status = await response.json();
    if (process.argv.includes('--json'))
        console.log(JSON.stringify(status, null, 2));
    else {
        console.log('SpekTrace · ' + status.window + ' · ' + status.asOf);
        console.log(status.capturedCalls + ' captured calls · ' + status.changedCalls + ' changed calls · ' + status.reportedFailedOutcomes + ' reported failed outcomes');
        for (const i of status.integrations)
            console.log(i.identity.key + ' / ' + i.identity.environment + ': ' + i.state + '; last received ' + (i.lastReceived ?? 'never'));
        console.log(status.unmatchedOutcomes + ' cumulative unmatched outcomes. ' + (status.coverage.length ? 'Coverage reports available; use --json for timestamps and counters.' : 'Capture coverage unknown.'));
        console.log(status.limitations.join(' '));
    }
}
main().catch(() => { console.error('Status unavailable. Check the server, status origin and private admin credential.'); process.exitCode = 1; });
