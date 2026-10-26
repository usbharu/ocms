import { expect, test } from '@playwright/test';

test('manifest and home screen icons are available', async ({ page }) => {
  await page.goto('/');
  const manifestURL = await page
    .locator('link[rel="manifest"]')
    .getAttribute('href');
  const response = await page.request.get(manifestURL ?? '');
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
  });
  for (const icon of manifest.icons) {
    const response = await page.request.get(icon.src);
    const bytes = await response.body();
    const size = Number(icon.sizes.split('x')[0]);
    expect(response.headers()['content-type']).toContain('image/png');
    expect(bytes.readUInt32BE(16)).toBe(size);
    expect(bytes.readUInt32BE(20)).toBe(size);
  }
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    'href',
    '/icons/icon-180.png',
  );
});

test('offline launch, retry, and cache isolation', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => resolve(),
          { once: true },
        ),
      );
    }
  });
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ json: { private: 'synthetic' } }),
  );
  await page.route('**/auth/config', (route) =>
    route.fulfill({ json: { development: false } }),
  );
  await page.evaluate(async () => {
    await fetch('/api/v1/me');
    await fetch('/api/v1/search', { method: 'POST', body: '{}' });
    await fetch('/api/v1/assets/synthetic/content', {
      headers: { Range: 'bytes=0-15' },
    });
    await fetch('/auth/config');
  });
  const paths = await page.evaluate(async () => {
    const cacheNames = await caches.keys();
    const keys = await Promise.all(
      cacheNames.map(async (name) => (await caches.open(name)).keys()),
    );
    return keys
      .flat()
      .map((request) => new URL(request.url).pathname)
      .sort();
  });
  expect(paths).toEqual(['/offline.css', '/offline.html']);
  await page.unrouteAll();
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'オフラインです' }),
  ).toBeVisible();
  expect(
    await page
      .locator('body')
      .evaluate((body) => getComputedStyle(body).margin),
  ).toBe('0px');
  const unavailable = await page.evaluate(async () => {
    return Promise.all(
      ['/api/v1/me', '/auth/config', '/api/v1/assets/synthetic/content'].map(
        async (path) => {
          try {
            await fetch(path);
            return false;
          } catch {
            return true;
          }
        },
      ),
    );
  });
  expect(unavailable).toEqual([true, true, true]);
  if (process.env.UI_SCREENSHOTS) {
    await page.screenshot({
      path: `${process.env.UI_SCREENSHOTS}/pwa-offline.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await expect(page.getByRole('link', { name: '再読み込み' })).toBeInViewport();
  if (process.env.UI_SCREENSHOTS) {
    await page.screenshot({
      path: `${process.env.UI_SCREENSHOTS}/pwa-offline-mobile.png`,
      fullPage: true,
    });
  }
  await context.setOffline(false);
  await page.getByRole('link', { name: '再読み込み' }).click();
  await expect(page.locator('#root')).toBeAttached();
  await expect(
    page.getByRole('heading', { name: 'オフラインです' }),
  ).toHaveCount(0);
});

test('activation removes only old OCMS offline caches', async ({ page }) => {
  // Seed caches before registration on a static page with no app script.
  await page.goto('/offline.html');
  await page.evaluate(async () => {
    await caches.open('ocms-offline-old');
    await caches.open('unrelated-cache');
  });
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const names = await page.evaluate(() => caches.keys());
  expect(names).not.toContain('ocms-offline-old');
  expect(names).toContain('unrelated-cache');
  expect(names.filter((name) => name.startsWith('ocms-offline-'))).toHaveLength(
    1,
  );
});
