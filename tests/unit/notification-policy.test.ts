import { vi } from 'vitest';
import { allowLocalDashboard, readSetupJson } from '@/lib/http/local-dashboard';
import { describe, it, expect } from 'vitest';
import { preferencesSchema, defaultPreferences, digestPeriod, shouldUpdate, safeText } from '@/lib/notifications/policy';
import { setupSchema, initialSetup, observerExample } from '@/lib/onboarding/setup';
describe('quiet notification policy', () => {
    it('starts disabled and rejects unknown fields and destination URL injection', () => { expect(defaultPreferences.enabled).toBe(false); expect(defaultPreferences.digest).toBe('off'); expect(preferencesSchema.safeParse({ destination: 'https://attacker.example' }).success).toBe(false); expect(preferencesSchema.safeParse({ token: 'secret' }).success).toBe(false); });
    it('does not alert for every repeat; flags volume milestones and new failed associations', () => { expect(shouldUpdate({ calls: 1, failed: 0 }, { calls: 2, failed: 0 })).toBe(false); expect(shouldUpdate({ calls: 9, failed: 0 }, { calls: 10, failed: 0 })).toBe(true); expect(shouldUpdate({ calls: 10, failed: 0 }, { calls: 11, failed: 0 })).toBe(false); expect(shouldUpdate({ calls: 10, failed: 0 }, { calls: 11, failed: 1 })).toBe(true); });
    it('uses UTC days and Monday weeks across year boundaries', () => { expect(digestPeriod(new Date('2027-01-03T23:59:59Z'), 'weekly')).toBe('2026-12-28'); expect(digestPeriod(new Date('2027-01-04T00:00:00Z'), 'weekly')).toBe('2027-01-04'); expect(digestPeriod(new Date('2027-01-03T23:59:59-06:00'), 'daily')).toBe('2027-01-04'); });
    it('neutralizes notification markup and limits labels', () => { expect(safeText('<!channel> & hello')).not.toContain('<'); expect(safeText('a'.repeat(500))).toHaveLength(300); });
});
describe('server setup examples', () => {
    const valid = { ...initialSetup, key: 'contacts', provider: 'crm' };
    it('keeps raw bodies and shape collection off unless fields are selected', () => { const text = observerExample(valid); expect(text).not.toContain('responsePointers:'); expect(text).toContain('process.env.SPEKTRACE_INGESTION_API_TOKEN'); expect(observerExample({ ...valid, pointers: '/count' })).toContain('responsePointers: ["/count"]'); });
    it('rejects credential-bearing origins, concrete customer identifiers and unsafe field names', () => { expect(setupSchema.safeParse(valid).success).toBe(true); expect(setupSchema.safeParse({ ...valid, providerOrigin: 'https://user:password@example.com' }).success).toBe(false); expect(setupSchema.safeParse({ ...valid, path: '/contacts/12345' }).success).toBe(false); expect(setupSchema.safeParse({ ...valid, pointers: '/constructor' }).success).toBe(false); });
});
describe('local setup access and bounded input', () => {
    it('rejects production access, nonlocal hosts and cross-site writes', () => { vi.stubEnv('NODE_ENV', 'development'); expect(allowLocalDashboard(new Request('http://127.0.0.1:3000/api/dashboard/onboarding', { headers: { origin: 'http://evil.example' } }), true)).toBe(false); expect(allowLocalDashboard(new Request('http://example.com/api/dashboard/onboarding'))).toBe(false); expect(allowLocalDashboard(new Request('http://127.0.0.1:3000/api/dashboard/onboarding', { headers: { origin: 'http://127.0.0.1:3000' } }), true)).toBe(true); expect(allowLocalDashboard(new Request('http://localhost:3000/api/dashboard/onboarding', {headers:{origin:'http://127.0.0.1:3000'}}),true)).toBe(true);
        expect(allowLocalDashboard(new Request('http://127.0.0.1:3000/api/dashboard/onboarding', {headers:{origin:'http://127.0.0.1:4000'}}),true)).toBe(false);
        vi.stubEnv('NODE_ENV', 'production'); expect(allowLocalDashboard(new Request('http://127.0.0.1:3000/api/dashboard/onboarding'))).toBe(false); vi.unstubAllEnvs(); });
    it('bounds actual bytes without trusting Content-Length', async () => { const make = (text: string) => new Request('http://127.0.0.1/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text }); await expect(readSetupJson(make('{"ok":true}'))).resolves.toEqual({ ok: true }); await expect(readSetupJson(make(JSON.stringify({ value: 'x'.repeat(3000) })))).rejects.toThrow('Body limit'); });
});
