import { expect, test } from '@playwright/test';

const partSize = 8 * 1024 * 1024;

test('複数ファイルの失敗後も続行し、受信済み部分から再試行する', async ({
  page,
}) => {
  const sessions: Record<
    string,
    { filename: string; parts: Set<number>; completed: boolean }
  > = {};
  const sends: string[] = [];
  let fail = true;
  await page.route('**/auth/config', (route) =>
    route.fulfill({ json: { development: true } }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/v1/me')
      return route.fulfill({
        json: { principal_id: 'alice', csrf_token: 'csrf' },
      });
    if (path === '/api/v1/uploads') {
      const id = String(Object.keys(sessions).length);
      sessions[id] = {
        filename: req.postDataJSON().filename,
        parts: new Set(),
        completed: false,
      };
      return route.fulfill({ json: { upload_id: id, asset_id: id } });
    }
    const match = path.match(
      /^\/api\/v1\/uploads\/(\d+)\/(parts(?:\/\d+)?|complete|content)$/,
    );
    if (match) {
      const [, id, action] = match;
      const session = sessions[id];
      if (action === 'parts')
        return route.fulfill({
          json: {
            part_size: partSize,
            parts: [...session.parts].map((part_number) => ({ part_number })),
            state: 'created',
          },
        });
      expect(req.headers()['x-csrf-token']).toBe('csrf');
      sends.push(`${id}/${action}`);
      if (action === 'parts/1' && fail)
        return route.fulfill({ status: 503, json: { error: 'UPLOAD_FAILED' } });
      if (action.startsWith('parts/')) {
        const number = Number(action.split('/')[1]);
        expect(req.postDataBuffer()?.length).toBe(number === 0 ? partSize : 17);
        session.parts.add(number);
      } else session.completed = true;
      return route.fulfill({ json: {} });
    }
    if (path === '/api/v1/assets')
      return route.fulfill({ json: { assets: [], total: 0 } });
    if (/\/assets\/\d+$/.test(path)) {
      const id = path.split('/').at(-1) ?? '';
      return route.fulfill({
        json: {
          asset_id: id,
          filename: sessions[id].filename,
          status: 'stored',
          mime_type: 'image/png',
          tags: [],
        },
      });
    }
    return route.fulfill({ json: { renditions: [], jobs: [] } });
  });
  await page.goto('/');
  await page.getByLabel('アップロードするファイル').setInputFiles([
    {
      name: 'large.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(partSize + 17, 7),
    },
    { name: 'small.png', mimeType: 'image/png', buffer: Buffer.from('small') },
  ]);
  const queue = page.getByRole('region', { name: 'アップロード状況' });
  await expect(queue).toContainText('1 / 2 件完了');
  expect(sessions['1'].completed).toBe(true);
  expect(sends.filter((value) => value === '0/parts/1')).toHaveLength(3);
  if (process.env.UI_SCREENSHOTS) {
    await page.setViewportSize({ width: 390, height: 844 });
    await queue.screenshot({ path: '../docs/uploads.png' });
  }
  fail = false;
  await page.getByRole('button', { name: 'large.pngを再試行' }).click();
  await expect(queue).toContainText('2 / 2 件完了');
  expect(Object.keys(sessions)).toHaveLength(2);
  expect(sends.filter((value) => value === '0/parts/0')).toHaveLength(1);
  expect(sends).toContain('0/complete');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
