// Smoke-тест: страница логина рендерится, кнопка ведёт на /oauth/login.
//
// Реальный OAuth-flow с Bitrix24 в этих тестах НЕ запускается (нужен
// портал-стенд). Полноценный e2e — после E1.2 + наличия test-стенда Bitrix24.

import { test, expect } from "@playwright/test";

test("login screen shows CTA and redirects to /oauth/login", async ({ page, baseURL }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /Вход в Toolkit/ })).toBeVisible();

  const cta = page.getByRole("button", { name: /Войти через Bitrix24/ });
  await expect(cta).toBeVisible();

  // Перехватим переход — мы не идём на реальный portal.softservice.by.
  let redirected: string | null = null;
  await page.route("**/oauth/login*", route => {
    redirected = route.request().url();
    return route.fulfill({ status: 204, body: "" });
  });

  await cta.click();
  // Дождёмся, пока навигация запустит наш роут.
  await page.waitForTimeout(200);

  expect(redirected).toBeTruthy();
  expect(redirected!).toContain("/oauth/login");
  expect(redirected!).toContain(`return_to=`);
  // Убедимся что baseURL не отвалился — просто чтобы конфиг был валиден.
  expect(baseURL).toBeTruthy();
});

test("anonymous user lands on /login when opening protected page", async ({ page }) => {
  await page.goto("/phone");
  await expect(page).toHaveURL(/\/login$/);
});
