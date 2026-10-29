import 'dotenv/config';
import { getPrisma } from '@/lib/db';
import { requireDatabaseUrl } from '@/lib/env';
import { deployMigrationsForUrl } from '@/lib/deploy-migrations';
async function main() {
    const db = getPrisma();
    try {
        const tables = await db.$queryRaw<{
            tablename: string;
        }[]> `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations'`;
        const counts = new Map<string, number>();
        for (const t of tables) {
            if (!/^[a-z_]+$/.test(t.tablename))
                throw Error('Unexpected table identifier');
            const rows = await db.$queryRawUnsafe<{
                count: bigint;
            }[]>('SELECT count(*) FROM "' + t.tablename + '"');
            counts.set(t.tablename, Number(rows[0].count));
        }
        deployMigrationsForUrl(requireDatabaseUrl());
        for (const [table, count] of counts) {
            const rows = await db.$queryRawUnsafe<{
                count: bigint;
            }[]>('SELECT count(*) FROM "' + table + '"');
            if (Number(rows[0].count) !== count)
                throw Error('Concurrent data change detected; inspect migration activation');
        }
        console.log('Notification migration installed. ' + counts.size + ' pre-existing table row counts unchanged. No credentials or delivery preferences were changed.');
    }
    finally {
        await db.$disconnect();
    }
}
main().catch(() => { console.error('Notification activation failed; inspect migrations without printing credentials.'); process.exitCode = 1; });
