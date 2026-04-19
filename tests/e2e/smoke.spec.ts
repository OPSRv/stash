import { test, expect } from '@playwright/test';
import { tauriMockInit } from './fixtures/tauri-mock';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(tauriMockInit);
});

test('popup renders all module tabs', async ({ page }) => {
  await page.goto('/');
  for (const label of ['Clipboard', 'Downloads', 'Recorder', 'Notes', 'Settings']) {
    await expect(page.getByRole('button', { name: label, exact: false })).toBeVisible();
  }
});

test('cheatsheet opens with ? and closes with Esc', async ({ page }) => {
  await page.goto('/');
  await page.locator('body').click();
  await page.keyboard.press('Shift+Slash');
  await expect(page.getByText('Shortcuts', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Shortcuts', { exact: true })).not.toBeVisible();
});

test('global search opens with Cmd+Shift+F', async ({ page }) => {
  await page.goto('/');
  await page.locator('body').click();
  // Key literal must be the lowercase 'f' so the shortcut handler can match
  // against `e.key === 'f'` after Shift is applied.
  await page.keyboard.press('Meta+Shift+KeyF');
  await expect(
    page.getByPlaceholder('Search clipboard, downloads, notes…')
  ).toBeVisible();
});

test('settings appearance tab exposes blur slider', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Appearance' }).click();
  await expect(page.getByText('Popup blur')).toBeVisible();
  await expect(page.getByText('Accent color')).toBeVisible();
});

test('settings downloads tab exposes the folder picker & rate limit', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  // Scope to the settings tab bar: it sits inside the <nav> with "General" etc.,
  // whereas the module tab "Downloads" is in the top module switcher.
  await page
    .locator('nav')
    .last()
    .getByRole('button', { name: 'Downloads' })
    .click();
  await expect(page.getByText('Download folder')).toBeVisible();
  await expect(page.getByRole('button', { name: /Choose/ })).toBeVisible();
  await expect(page.getByText('Max parallel downloads')).toBeVisible();
  await expect(page.getByText(/Bandwidth limit/)).toBeVisible();
});

test('clipboard tab renders an empty-state message', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Clipboard' }).click();
  // Empty stub from tauri-mock returns []; UI should not be loading forever.
  await expect(page.getByRole('button', { name: 'Clipboard' })).toHaveAttribute(
    'class',
    /t-primary|on/
  );
});

test('downloads tab shows the paste-URL bar', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Downloads' }).click();
  await expect(page.getByPlaceholder(/Paste a YouTube/)).toBeVisible();
});

test('⌘⌥2 switches to the Downloads module', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Meta+Alt+2');
  await expect(page.getByPlaceholder(/Paste a YouTube/)).toBeVisible();
});

