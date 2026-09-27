import { expect, test } from '@playwright/test';
import { deleteSlide, duplicateSlide, openSlide, readSlideSource } from './helpers.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const placeholder = 'Write speaker notes for this slide (Markdown supported)…';

for (const mode of ['autosave', 'flush', 'revert'] as const) {
  test(`notes preserve newer edits and caret after an older save (${mode})`, async ({
    page,
    request,
  }) => {
    const slideId = `notes-race-${mode}`;
    try {
      await duplicateSlide(request, 'alpha', slideId);
      await openSlide(page, slideId);
      await page.getByRole('button', { name: /Notes/ }).click();
      const textarea = page.getByPlaceholder(placeholder);
      await expect(textarea).toBeVisible();
      await page.clock.install();
      await page.clock.pauseAt(new Date(Date.now() + 100));
      const received = deferred();
      const release = deferred();
      await page.route('**/__notes', async (route) => {
        const response = await route.fetch();
        if (route.request().postDataJSON().text === 'hello world') {
          received.resolve();
          await release.promise;
        }
        await route.fulfill({ response });
      });
      await textarea.fill('hello world');
      await page.clock.runFor(600);
      await received.promise;
      const expected = mode === 'revert' ? 'Alpha speaker note' : 'hello NEW world';
      if (mode === 'revert') {
        await textarea.fill(expected);
      } else {
        await textarea.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 6));
        await page.keyboard.insertText('NEW ');
      }
      const caret = mode === 'revert' ? expected.length : 10;
      const response = page.waitForResponse((res) => res.url().endsWith('/__notes'));
      release.resolve();
      await response;
      await page.clock.runFor(50);
      expect
        .soft(
          await textarea.evaluate((el: HTMLTextAreaElement) => [
            el.selectionStart,
            el.selectionEnd,
          ]),
        )
        .toEqual([caret, caret]);
      await expect(textarea).toHaveValue(expected);
      await expect(textarea).toBeFocused();
      const latestSaved = page.waitForResponse(
        (res) => res.url().endsWith('/__notes') && res.request().postDataJSON().text === expected,
      );
      if (mode === 'flush') await textarea.press('ControlOrMeta+Enter');
      else await page.clock.runFor(600);
      expect((await latestSaved).ok()).toBe(true);
      await expect.poll(() => readSlideSource(slideId)).toContain(expected);
      expect(await readSlideSource(slideId)).not.toContain('hello world');
      await expect(page.locator('[data-notes-drawer] [aria-live]')).toHaveText('Saved');
    } finally {
      await page.close();
      await deleteSlide(request, slideId);
    }
  });
}

for (const fail of [false, true]) {
  for (const saveNewFirst of [false, true]) {
    test(`notes ignore a previous page's late ${fail ? 'error' : 'success'} (${saveNewFirst ? 'saved' : 'pending'} new edits)`, async ({
      page,
      request,
    }) => {
      const slideId = `notes-navigation-${fail}-${saveNewFirst}`;
      try {
        await duplicateSlide(request, 'alpha', slideId);
        await openSlide(page, slideId);
        await page.getByRole('button', { name: /Notes/ }).click();
        const textarea = page.getByPlaceholder(placeholder);
        await expect(textarea).toBeVisible();
        await page.clock.install();
        await page.clock.pauseAt(new Date(Date.now() + 100));
        const received = deferred();
        const release = deferred();
        await page.route('**/__notes', async (route) => {
          if (route.request().postDataJSON().index !== 0) {
            await route.continue();
            return;
          }
          const response = await route.fetch();
          received.resolve();
          await release.promise;
          await route.fulfill(
            fail ? { status: 500, json: { error: 'Delayed old-page failure' } } : { response },
          );
        });
        await textarea.fill('First page pending note');
        await page
          .getByRole('button', { name: 'Go to page 2' })
          .evaluate((el: HTMLButtonElement) => el.click());
        await received.promise;
        await expect(textarea).toHaveValue('');
        await textarea.fill('Second page pending note');
        if (saveNewFirst) {
          await textarea.press('ControlOrMeta+Enter');
          await expect(page.locator('[data-notes-drawer] [aria-live]')).toHaveText('Saved');
        }
        const response = page.waitForResponse(
          (res) => res.url().endsWith('/__notes') && res.request().postDataJSON().index === 0,
        );
        release.resolve();
        await response;
        await page.clock.runFor(50);
        await expect(textarea).toHaveValue('Second page pending note');
        await expect(page.locator('[data-notes-drawer] [aria-live]')).toHaveText(
          saveNewFirst ? 'Saved' : '',
        );
        await textarea.press('ControlOrMeta+Enter');
        await expect.poll(() => readSlideSource(slideId)).toContain('Second page pending note');
        if (!fail) {
          await page.getByRole('button', { name: 'Go to page 1' }).click();
          await expect(textarea).toHaveValue('First page pending note');
        }
      } finally {
        await page.close();
        await deleteSlide(request, slideId);
      }
    });
  }
}
