import { expect, type Route, test } from '@playwright/test';

const partSize = 8 * 1024 * 1024;

for (const mode of ['original-first', 'numbered-first', 'hash-failure']) {
  test(`番号付きの完全一致ファイルだけを通知せず除外する: ${mode}`, async ({
    page,
  }) => {
    if (mode === 'hash-failure') {
      await page.addInitScript(() => {
        crypto.subtle.digest = async () => {
          throw new Error('Hash unavailable');
        };
      });
    }
    const uploads: { name: string; content?: string }[] = [];
    await page.route('**/auth/config', (route) =>
      route.fulfill({ json: { development: true } }),
    );
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/v1/me')
        return route.fulfill({
          json: { principal_id: 'alice', csrf_token: 'csrf' },
        });
      if (path === '/api/v1/uploads') {
        const id = String(uploads.length);
        uploads.push({ name: request.postDataJSON().filename });
        return route.fulfill({ json: { upload_id: id, asset_id: id } });
      }
      const content = path.match(/^\/api\/v1\/uploads\/(\d+)\/content$/);
      if (content) {
        uploads[Number(content[1])].content =
          request.postDataBuffer()?.toString() ?? '';
        return route.fulfill({ json: {} });
      }
      if (path === '/api/v1/assets')
        return route.fulfill({ json: { assets: [], total: 0 } });
      const asset = path.match(/^\/api\/v1\/assets\/(\d+)$/);
      if (asset)
        return route.fulfill({
          json: {
            asset_id: asset[1],
            filename: uploads[Number(asset[1])].name,
            status: 'stored',
            mime_type: 'image/png',
            tags: [],
          },
        });
      return route.fulfill({ json: { renditions: [], jobs: [] } });
    });
    const retained = [
      ['hoge.png', 'same'],
      ['hoge(8).png', 'diff'], // Same size, different hash.
      ['hoge(9).png', 'longer'],
      ['alone(1).png', 'same'],
      ['other.png', 'same'],
      ['hoge(1).jpg', 'same'],
      ['hoge(text).png', 'same'],
      ['empty.png', ''],
      ['archive.tar.gz', 'same'],
      ['no-extension', 'same'],
    ];
    const duplicates = [
      ['hoge(1).png', 'same'],
      ['hoge (2).png', 'same'],
      ['hoge（3）.png', 'same'],
      ['hoge　（42）.png', 'same'],
      ['hoge(-7).png', 'same'],
      ['hoge(+5).png', 'same'],
      ['hoge(0).png', 'same'],
      ['empty (1).png', ''],
      ['archive.tar (1).gz', 'same'],
      ['no-extension（1）', 'same'],
    ];
    const files =
      mode === 'numbered-first'
        ? [...duplicates, ...retained]
        : [...retained, ...duplicates];
    const expected = mode === 'hash-failure' ? files : retained;
    const dialogs: string[] = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await page.goto('/');
    const input = page.getByLabel('アップロードするファイル');
    await input.setInputFiles(
      files.map(([name, content]) => ({
        name,
        mimeType: 'image/png',
        buffer: Buffer.from(content),
      })),
    );
    const queue = page.getByRole('region', { name: 'アップロード状況' });
    await expect(queue).toContainText(
      `${expected.length} / ${expected.length} 件完了`,
    );
    expect(uploads).toEqual(
      expected.map(([name, content]) => ({ name, content })),
    );
    await expect(queue.locator('li')).toHaveCount(expected.length);
    expect(dialogs).toEqual([]);

    // A separate selection must not be compared with an earlier batch.
    await expect(
      page.getByRole('button', { name: '＋ アップロード' }),
    ).toBeEnabled();
    await input.setInputFiles({
      name: 'hoge(1).png',
      mimeType: 'image/png',
      buffer: Buffer.from('same'),
    });
    await expect(queue).toContainText('1 / 1 件完了');
    expect(uploads.at(-1)).toEqual({ name: 'hoge(1).png', content: 'same' });
    expect(uploads).toHaveLength(expected.length + 1);
  });
}

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
      const id = req.postDataJSON().filename === 'large.png' ? '0' : '1';
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
  await expect(
    page.getByRole('button', { name: 'large.pngを再試行' }),
  ).toBeEnabled();
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

test('最大10ファイルを並列に送り、完了・失敗した枠で後続を開始する', async ({
  page,
}) => {
  const started: string[] = [];
  const pending = new Map<string, Route>();
  const selected: string[] = [];
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
      const id = req.postDataJSON().filename;
      started.push(id);
      return route.fulfill({ json: { upload_id: id, asset_id: id } });
    }
    const match = path.match(/^\/api\/v1\/uploads\/([^/]+)\/content$/);
    if (match) {
      expect(req.headers()['x-csrf-token']).toBe('csrf');
      pending.set(match[1], route);
      return;
    }
    if (path === '/api/v1/assets')
      return route.fulfill({ json: { assets: [], total: 0 } });
    if (/\/assets\/[^/]+$/.test(path)) {
      const id = path.split('/').at(-1) ?? '';
      selected.push(id);
      return route.fulfill({
        json: {
          asset_id: id,
          filename: id,
          status: 'stored',
          mime_type: 'image/png',
          tags: [],
        },
      });
    }
    return route.fulfill({ json: { renditions: [], jobs: [] } });
  });
  await page.goto('/');
  await page.getByLabel('アップロードするファイル').setInputFiles(
    Array.from({ length: 12 }, (_, i) => i + 1).map((number) => ({
      name: `${number}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from('synthetic'),
    })),
  );
  const queue = page.getByRole('region', { name: 'アップロード状況' });
  await expect.poll(() => pending.size).toBe(10);
  expect(started).toHaveLength(10);
  await expect(queue.getByRole('progressbar')).toHaveCount(10);
  await expect(queue.getByText('待機中', { exact: true })).toHaveCount(2);

  // A failed request frees a slot even while the other uploads remain blocked.
  await pending.get('2.png')?.fulfill({ status: 503, json: {} });
  pending.delete('2.png');
  await expect.poll(() => pending.has('11.png')).toBe(true);
  expect(pending.size).toBe(10);
  expect(started).toHaveLength(11);
  await expect(
    page.getByRole('button', { name: '2.pngを再試行' }),
  ).toBeDisabled();

  await pending.get('3.png')?.fulfill({ json: {} });
  pending.delete('3.png');
  await expect.poll(() => pending.has('12.png')).toBe(true);
  expect(pending.size).toBe(10);
  expect(started).toHaveLength(12);
  // Finish out of order; selection still follows the original file order.
  for (const id of [
    '12.png',
    '11.png',
    '10.png',
    '9.png',
    '8.png',
    '7.png',
    '6.png',
    '5.png',
    '4.png',
  ]) {
    await pending.get(id)?.fulfill({ json: {} });
    pending.delete(id);
  }
  await expect(queue).toContainText('10 / 12 件完了');
  expect(selected).toEqual([]);
  await pending.get('1.png')?.fulfill({ json: {} });
  pending.delete('1.png');
  await expect(queue).toContainText('11 / 12 件完了');
  await expect(
    page.getByRole('button', { name: '2.pngを再試行' }),
  ).toBeEnabled();
  expect(selected[0]).toBe('12.png');
});
