import "dotenv/config";
import { getPrisma } from "@/lib/db";
import { runNotificationCycle } from "@/server/notifications/runner";

async function main() {
    const db = getPrisma();
    let stop = false;
    process.once('SIGINT', () => { stop = true; });
    process.once('SIGTERM', () => { stop = true; });
    try {
        do {
            try {
                await runNotificationCycle(db);
            }
            catch {
                console.error('Notification cycle failed. Check migrations and destination configuration; no destination secrets were logged.');
                if (process.argv.includes('--once'))
                    process.exitCode = 1;
            }
            if (process.argv.includes('--once') || stop)
                break;
            await new Promise(r => setTimeout(r, 10000));
        } while (!stop);
    }
    finally {
        await db.$disconnect();
    }
}
main().catch(() => { console.error('Notification worker unavailable'); process.exitCode = 1; });
