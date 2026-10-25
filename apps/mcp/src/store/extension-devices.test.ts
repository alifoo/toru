import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withRecorderStore } from './open.js';
import { ExtensionDeviceStore } from './extension-devices.js';

it('renews with a replaced refresh token only for two minutes after the rotation, then never again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'toru-extension-store-'));
  try {
    await withRecorderStore(dir, db => {
      db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run('owner', 0);
      const store = new ExtensionDeviceStore(db);
      const first = store.register('owner', 'Chrome', 1_000);
      const second = store.refresh(first.refreshToken, 2_000)!;
      // Two calls renewing at once: the replaced token renews again, and the newest credentials win.
      const raced = store.refresh(first.refreshToken, 3_000)!;
      expect(raced.deviceId).toBe(first.deviceId);
      expect(store.authenticate(raced.accessToken, 3_500)).toBeDefined();
      expect(store.authenticate(second.accessToken, 3_500)).toBeUndefined();
      // The call that lost the race holds `second`; it was just replaced, so it renews within the grace.
      const recovered = store.refresh(second.refreshToken, 4_000)!;
      expect(store.authenticate(recovered.accessToken, 4_500)).toBeDefined();
      // Older tokens are gone, and a replaced token renews only within two minutes.
      expect(store.refresh(first.refreshToken, 5_000)).toBeUndefined();
      const later = store.refresh(recovered.refreshToken, 10_000)!;
      expect(store.refresh(recovered.refreshToken, 10_000 + 2 * 60_000 + 1)).toBeUndefined();
      expect(store.refresh(later.refreshToken, 10_000 + 2 * 60_000 + 1)).toBeDefined();
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
