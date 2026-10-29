import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { requireTestDatabaseUrl } from '@/lib/env';
import { deployMigrationsForUrl } from '@/lib/deploy-migrations';
async function main() {
    const base = requireTestDatabaseUrl(), name = 'spektrace_test_notify_' + randomUUID().replaceAll('-', '');
    if (!/^spektrace_test_notify_[a-f0-9]{32}$/.test(name))
        throw Error('Unsafe test target');
    const admin = new Client({ connectionString: base });
    await admin.connect();
    let created = false;
    const dir = 'work/notifications-verification/' + randomUUID();
    await mkdir(dir, { recursive: true });
    try {
        await admin.query('CREATE DATABASE "' + name + '"');
        created = true;
        const url = new URL(base);
        url.pathname = '/' + name;
        deployMigrationsForUrl(url.toString());
        const child = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/unit/notification-policy.test.ts', 'tests/integration/notifications.test.ts','tests/integration/account-workflow.test.ts'], { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, TEST_DATABASE_URL: url.toString(), SPEKTRACE_NOTIFICATION_TEST_DATABASE: name, SPEKTRACE_NOTIFICATION_DESTINATIONS: '{}' }, encoding: 'utf8', windowsHide: true });
        await writeFile(dir + '/stdout.log', child.stdout ?? '');
        await writeFile(dir + '/stderr.log', child.stderr ?? '');
        console.log(child.stdout);
        console.error(child.stderr);
        await writeFile(dir + '/report.json', JSON.stringify({ syntheticOnly: true, realDestinationsContacted: false, exitCode: child.status, database: name }, null, 2));
        process.exitCode = child.status ?? 1;
        console.log('Notification verification: ' + dir);
    }
    finally {
        if (created) {
            await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
            await admin.query('DROP DATABASE "' + name + '"');
        }
        await admin.end();
    }
}
main().catch(() => { console.error('Notification verification failed. Connection details withheld.'); process.exitCode = 1; });
