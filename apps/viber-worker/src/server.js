const express = require("express");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const port = Number(process.env.VIBER_WORKER_PORT || "8091");
const profileRoot = process.env.VIBER_PROFILE_DIR || "/data/profiles";
const entryUrl = process.env.VIBER_ENTRY_URL || "https://account.viber.com/";
const loginTtlMs = Number(process.env.VIBER_LOGIN_TTL_MS || "300000");
const qrSelector = process.env.VIBER_QR_SELECTOR || "";
const headless = String(process.env.VIBER_HEADLESS || "true") !== "false";
const clientMode = process.env.VIBER_CLIENT_MODE || "browser";
const desktopCommand = process.env.VIBER_DESKTOP_COMMAND || "";
const stage = process.env.VIBER_STAGE || "production";
const startedAt = new Date();
const app = express();

app.use(express.json({ limit: "2mb" }));

const logins = new Map();
const sessions = new Map();

app.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    stage,
    mode: clientMode,
    entry_url: entryUrl,
    desktop_configured: Boolean(desktopCommand),
    active_logins: logins.size,
    active_sessions: sessions.size,
    uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
  });
});

app.get("/readyz", (_req, res) => {
  const desktopReady = clientMode !== "desktop" || Boolean(desktopCommand);
  res.status(desktopReady ? 200 : 503).json({
    status: desktopReady ? "ready" : "not_ready",
    stage,
    mode: clientMode,
    desktop_configured: Boolean(desktopCommand),
  });
});

app.post("/viber/login/start", async (req, res) => {
  cleanupExpiredLogins();
  const accountId = cleanID(req.body?.account_id) || crypto.randomUUID();
  const profileKey = cleanID(req.body?.profile_key) || accountId;
  const loginId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + loginTtlMs);
  const login = {
    id: loginId,
    accountId,
    profileKey,
    status: "pending",
    entryUrl: String(req.body?.entry_url || entryUrl),
    qrImage: "",
    screenshot: "",
    error: "",
    expiresAt,
    createdAt: new Date(),
  };
  logins.set(loginId, login);

  try {
    const session = await ensureSession(accountId, profileKey, login.entryUrl);
    if (session.mode === "browser") {
      login.screenshot = await screenshotDataURL(session.page);
      login.qrImage = qrSelector ? await screenshotDataURL(session.page, qrSelector).catch(() => "") : "";
      login.status = "manual_action_required";
    } else {
      login.status = "desktop_manual_action_required";
      login.error = "Viber Desktop process started. QR/screen streaming requires the next noVNC/X11 bridge step.";
    }
    res.json(publicLogin(login));
  } catch (err) {
    login.status = "error";
    login.error = errorMessage(err);
    res.status(502).json({ error: { code: "viber_login_start_failed", message: login.error } });
  }
});

app.get("/viber/login/:id", async (req, res) => {
  cleanupExpiredLogins();
  const login = logins.get(req.params.id);
  if (!login) {
    res.status(404).json({ error: { code: "viber_login_not_found", message: "Login not found" } });
    return;
  }
  if (Date.now() > login.expiresAt.getTime() && login.status === "pending") {
    login.status = "expired";
  }
  const session = sessions.get(login.accountId);
  if (session?.page && login.status !== "expired" && login.status !== "error") {
    login.screenshot = await screenshotDataURL(session.page).catch(() => login.screenshot);
    login.qrImage = qrSelector ? await screenshotDataURL(session.page, qrSelector).catch(() => login.qrImage) : login.qrImage;
  }
  res.json(publicLogin(login));
});

app.post("/viber/session/status", async (req, res) => {
  const accountId = cleanID(req.body?.account_id);
  if (!accountId) {
    res.status(400).json({ error: { code: "bad_request", message: "account_id is required" } });
    return;
  }
  const session = sessions.get(accountId);
  if (!session) {
    res.json({ connected: false, status: "stopped" });
    return;
  }
  const title = session.page ? await session.page.title().catch(() => "") : "";
  res.json({
    connected: true,
    status: "running",
    account_id: accountId,
    profile_key: session.profileKey,
    mode: session.mode,
    title: session.page ? title : "Viber Desktop",
    url: session.page ? session.page.url() : "",
    started_at: session.startedAt.toISOString(),
  });
});

app.post("/viber/session/stop", async (req, res) => {
  const accountId = cleanID(req.body?.account_id);
  if (!accountId) {
    res.status(400).json({ error: { code: "bad_request", message: "account_id is required" } });
    return;
  }
  await stopSession(accountId);
  res.json({ status: "stopped" });
});

app.post("/viber/chats/sync", notImplemented("viber_chats_sync_not_implemented", "PoC worker can start/login only. Chat scraping starts after stable Viber client target is confirmed."));
app.post("/viber/messages/sync", notImplemented("viber_messages_sync_not_implemented", "PoC worker can start/login only. Message scraping starts after stable selectors are confirmed."));
app.post("/viber/messages/send", notImplemented("viber_send_not_implemented", "PoC worker can start/login only. Sending starts after chat/message scraping is stable."));
app.post("/viber/media/download", notImplemented("viber_media_download_not_implemented", "PoC worker can start/login only. Media download starts after attachment selectors are confirmed."));
app.post("/viber/updates/start", notImplemented("viber_updates_not_implemented", "PoC worker can start/login only. Realtime watcher starts after sync is stable."));

async function ensureSession(accountId, profileKey, url) {
  const existing = sessions.get(accountId);
  if (existing) {
    if (existing.mode === "desktop") {
      return existing;
    }
    if (existing.page.isClosed()) {
      await stopSession(accountId);
    } else {
      await existing.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined);
      return existing;
    }
  }

  if (clientMode === "desktop") {
    if (!desktopCommand) {
      const err = new Error("VIBER_CLIENT_MODE=desktop requires VIBER_DESKTOP_COMMAND. Install Viber Desktop runtime and point this command to the launcher.");
      err.statusCode = 501;
      throw err;
    }
    const child = spawn(desktopCommand, { shell: true, stdio: "ignore", detached: true });
    child.unref();
    const session = { accountId, profileKey, mode: "desktop", process: child, startedAt: new Date() };
    sessions.set(accountId, session);
    return session;
  }

  await fs.mkdir(profileRoot, { recursive: true });
  const profilePath = path.join(profileRoot, safeSegment(profileKey));
  const context = await chromium.launchPersistentContext(profilePath, {
    headless,
    viewport: { width: 1365, height: 900 },
    locale: "ru-RU",
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1500);

  const session = { accountId, profileKey, mode: "browser", context, page, startedAt: new Date() };
  sessions.set(accountId, session);
  return session;
}

async function stopSession(accountId) {
  const session = sessions.get(accountId);
  if (!session) return;
  sessions.delete(accountId);
  if (session.context) await session.context.close().catch(() => undefined);
  if (session.process) {
    try {
      process.kill(-session.process.pid, "SIGTERM");
    } catch {
      // already stopped
    }
  }
}

async function screenshotDataURL(page, selector) {
  const target = selector ? page.locator(selector).first() : page;
  const bytes = await target.screenshot({ type: "png" });
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function publicLogin(login) {
  return {
    login_id: login.id,
    status: login.status,
    account_id: login.accountId,
    profile_key: login.profileKey,
    entry_url: login.entryUrl,
    qr_image: login.qrImage || undefined,
    screenshot: login.screenshot || undefined,
    expires_at: login.expiresAt.toISOString(),
    error: login.error || undefined,
  };
}

function notImplemented(code, message) {
  return (_req, res) => {
    res.status(501).json({ error: { code, message, stage, mode: clientMode } });
  };
}

function cleanupExpiredLogins() {
  const now = Date.now();
  for (const [id, login] of logins.entries()) {
    if (now > login.expiresAt.getTime() + 60_000) {
      logins.delete(id);
    } else if (now > login.expiresAt.getTime() && login.status === "pending") {
      login.status = "expired";
    }
  }
}

function cleanID(value) {
  return String(value || "").trim();
}

function safeSegment(value) {
  return cleanID(value).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160) || crypto.randomUUID();
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

process.on("SIGTERM", async () => {
  await Promise.all(Array.from(sessions.keys()).map(stopSession));
  process.exit(0);
});

app.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", msg: "viber-worker listening", port, entry_url: entryUrl, headless, mode: clientMode, stage }));
});
