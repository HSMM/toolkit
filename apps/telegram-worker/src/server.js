const express = require("express");
const QRCode = require("qrcode");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const crypto = require("crypto");

const apiId = Number(process.env.TELEGRAM_API_ID || "0");
const apiHash = process.env.TELEGRAM_API_HASH || "";
const port = Number(process.env.TELEGRAM_WORKER_PORT || "8090");
const loginTtlMs = Number(process.env.TELEGRAM_LOGIN_TTL_MS || "180000");

const app = express();
app.use(express.json({ limit: "80mb" }));

const logins = new Map();
const updateClients = new Map();

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/telegram/qr/start", async (req, res) => {
  const requestApiId = Number(req.body?.api_id || apiId || "0");
  const requestApiHash = String(req.body?.api_hash || apiHash || "");
  if (!requestApiId || !requestApiHash) {
    res.status(503).json({ error: { code: "telegram_not_configured", message: "TELEGRAM_API_ID/API_HASH are not configured" } });
    return;
  }

  const loginId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + loginTtlMs);
  const client = new TelegramClient(new StringSession(""), requestApiId, requestApiHash, { connectionRetries: 5 });
  const login = {
    id: loginId,
    status: "pending",
    userId: String(req.body?.user_id || ""),
    apiId: requestApiId,
    apiHash: requestApiHash,
    client,
    qrPayload: "",
    qrImage: "",
    expiresAt,
    error: "",
    session: "",
    account: null,
  };
  logins.set(loginId, login);

  const firstQr = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("QR generation timeout")), 15000);
    login.resolveFirstQr = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    login.rejectFirstQr = (err) => {
      clearTimeout(timer);
      reject(err);
    };
  });

  void runQrLogin(login);

  try {
    await firstQr;
    res.json(toPublicLogin(login));
  } catch (err) {
    login.status = "error";
    login.error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: { code: "telegram_qr_failed", message: login.error } });
  }
});

app.get("/telegram/qr/:id", (req, res) => {
  const login = logins.get(req.params.id);
  if (!login) {
    res.status(404).json({ error: { code: "telegram_login_not_found", message: "Login not found" } });
    return;
  }
  if (Date.now() > login.expiresAt.getTime() && login.status === "pending") {
    login.status = "expired";
    safeDisconnect(login.client);
  }
  res.json(toPublicLogin(login));
});

app.post("/telegram/chats/sync", async (req, res) => {
  const requestApiId = Number(req.body?.api_id || apiId || "0");
  const requestApiHash = String(req.body?.api_hash || apiHash || "");
  const session = String(req.body?.session || "");
  const limit = Math.min(Math.max(Number(req.body?.limit || 100), 1), 500);

  if (!requestApiId || !requestApiHash || !session) {
    res.status(400).json({ error: { code: "bad_request", message: "api_id, api_hash and session are required" } });
    return;
  }

  const client = new TelegramClient(new StringSession(session), requestApiId, requestApiHash, { connectionRetries: 5 });
  try {
    await client.connect();
    const dialogs = await client.getDialogs({ limit });
    const items = dialogs
      .map(dialogToChat)
      .filter((item) => item && (item.type === "private" || item.type === "group"));
    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: { code: "telegram_sync_failed", message: err instanceof Error ? err.message : String(err) } });
  } finally {
    safeDisconnect(client);
  }
});

app.post("/telegram/messages/sync", async (req, res) => {
  const requestApiId = Number(req.body?.api_id || apiId || "0");
  const requestApiHash = String(req.body?.api_hash || apiHash || "");
  const session = String(req.body?.session || "");
  const providerChatId = String(req.body?.provider_chat_id || "");
  const limit = Math.min(Math.max(Number(req.body?.limit || 50), 1), 500);

  if (!requestApiId || !requestApiHash || !session || !providerChatId) {
    res.status(400).json({ error: { code: "bad_request", message: "api_id, api_hash, session and provider_chat_id are required" } });
    return;
  }

  const client = new TelegramClient(new StringSession(session), requestApiId, requestApiHash, { connectionRetries: 5 });
  try {
    await client.connect();
    const dialogs = await client.getDialogs({ limit: 500 });
    const dialog = dialogs.find((item) => stringifyId(item.id || item.entity?.id) === providerChatId);
    if (!dialog) {
      res.status(404).json({ error: { code: "telegram_chat_not_found", message: "Chat not found in Telegram dialogs" } });
      return;
    }
    const messages = await client.getMessages(dialog.entity, { limit });
    const items = messages.map((message) => messageToItem(message)).filter(Boolean);
    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: { code: "telegram_messages_sync_failed", message: err instanceof Error ? err.message : String(err) } });
  } finally {
    safeDisconnect(client);
  }
});

app.post("/telegram/messages/send", async (req, res) => {
  const requestApiId = Number(req.body?.api_id || apiId || "0");
  const requestApiHash = String(req.body?.api_hash || apiHash || "");
  const session = String(req.body?.session || "");
  const providerChatId = String(req.body?.provider_chat_id || "");
  const text = String(req.body?.text || "").trim();
  const files = Array.isArray(req.body?.files) ? req.body.files : [];

  if (!requestApiId || !requestApiHash || !session || !providerChatId || (!text && files.length === 0)) {
    res.status(400).json({ error: { code: "bad_request", message: "api_id, api_hash, session, provider_chat_id and text or files are required" } });
    return;
  }

  const client = new TelegramClient(new StringSession(session), requestApiId, requestApiHash, { connectionRetries: 5 });
  try {
    await client.connect();
    const dialogs = await client.getDialogs({ limit: 500 });
    const dialog = dialogs.find((item) => stringifyId(item.id || item.entity?.id) === providerChatId);
    if (!dialog) {
      res.status(404).json({ error: { code: "telegram_chat_not_found", message: "Chat not found in Telegram dialogs" } });
      return;
    }
    const sentItems = [];
    if (files.length > 0) {
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i] || {};
        const data = Buffer.from(String(file.data || ""), "base64");
        if (!data.length) continue;
        const sent = await client.sendFile(dialog.entity, {
          file: data,
          fileName: String(file.file_name || "attachment"),
          caption: i === 0 ? text : "",
          attributes: [],
        });
        const item = Array.isArray(sent) ? sent.map(messageToItem).filter(Boolean) : [messageToItem(sent)].filter(Boolean);
        sentItems.push(...item);
      }
    } else {
      const sent = await client.sendMessage(dialog.entity, { message: text });
      const item = messageToItem(sent);
      if (item) sentItems.push(item);
    }
    res.json({ items: sentItems });
  } catch (err) {
    res.status(502).json({ error: { code: "telegram_send_failed", message: err instanceof Error ? err.message : String(err) } });
  } finally {
    safeDisconnect(client);
  }
});

app.post("/telegram/media/download", async (req, res) => {
  const requestApiId = Number(req.body?.api_id || apiId || "0");
  const requestApiHash = String(req.body?.api_hash || apiHash || "");
  const session = String(req.body?.session || "");
  const providerChatId = String(req.body?.provider_chat_id || "");
  const providerMessageId = Number(req.body?.provider_message_id || 0);

  if (!requestApiId || !requestApiHash || !session || !providerChatId || !providerMessageId) {
    res.status(400).json({ error: { code: "bad_request", message: "api_id, api_hash, session, provider_chat_id and provider_message_id are required" } });
    return;
  }

  const client = new TelegramClient(new StringSession(session), requestApiId, requestApiHash, { connectionRetries: 5 });
  try {
    await client.connect();
    const dialogs = await client.getDialogs({ limit: 500 });
    const dialog = dialogs.find((item) => stringifyId(item.id || item.entity?.id) === providerChatId);
    if (!dialog) {
      res.status(404).json({ error: { code: "telegram_chat_not_found", message: "Chat not found in Telegram dialogs" } });
      return;
    }
    const messages = await client.getMessages(dialog.entity, { ids: [providerMessageId] });
    const message = Array.isArray(messages) ? messages[0] : messages;
    if (!message) {
      res.status(404).json({ error: { code: "telegram_message_not_found", message: "Message not found" } });
      return;
    }
    const data = await client.downloadMedia(message, {});
    if (!data) {
      res.status(404).json({ error: { code: "telegram_media_not_found", message: "Message has no downloadable media" } });
      return;
    }
    const attachments = extractAttachments(message);
    const first = attachments[0] || {};
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    res.json({
      file_name: first.file_name || `telegram-${providerMessageId}`,
      mime_type: first.mime_type || "application/octet-stream",
      data: buffer.toString("base64"),
    });
  } catch (err) {
    res.status(502).json({ error: { code: "telegram_media_download_failed", message: err instanceof Error ? err.message : String(err) } });
  } finally {
    safeDisconnect(client);
  }
});

app.post("/telegram/updates/start", async (req, res) => {
  const requestApiId = Number(req.body?.api_id || apiId || "0");
  const requestApiHash = String(req.body?.api_hash || apiHash || "");
  const session = String(req.body?.session || "");
  const accountId = String(req.body?.account_id || "");
  const callbackUrl = String(req.body?.callback_url || "");
  const callbackSecret = String(req.body?.callback_secret || "");

  if (!requestApiId || !requestApiHash || !session || !accountId || !callbackUrl || !callbackSecret) {
    res.status(400).json({ error: { code: "bad_request", message: "api_id, api_hash, session, account_id, callback_url and callback_secret are required" } });
    return;
  }

  await stopUpdateClient(accountId);
  const client = new TelegramClient(new StringSession(session), requestApiId, requestApiHash, { connectionRetries: 5 });
  try {
    await client.connect();
    const listener = { accountId, client, callbackUrl, callbackSecret };
    const handler = async (event) => {
      await handleNewMessage(listener, event).catch((err) => {
        console.error(JSON.stringify({ level: "warn", msg: "telegram update callback failed", account_id: accountId, err: err instanceof Error ? err.message : String(err) }));
      });
    };
    client.addEventHandler(handler, new NewMessage({}));
    listener.handler = handler;
    updateClients.set(accountId, listener);
    res.json({ status: "started" });
  } catch (err) {
    safeDisconnect(client);
    res.status(502).json({ error: { code: "telegram_updates_start_failed", message: err instanceof Error ? err.message : String(err) } });
  }
});

async function runQrLogin(login) {
  try {
    await login.client.connect();
    const user = await login.client.signInUserWithQrCode(
      { apiId: login.apiId, apiHash: login.apiHash },
      {
        qrCode: async (code) => {
          const payload = `tg://login?token=${code.token.toString("base64url")}`;
          login.qrPayload = payload;
          login.qrImage = await QRCode.toDataURL(payload, { margin: 1, width: 256 });
          login.resolveFirstQr?.(true);
        },
        password: async (hint) => {
          login.status = "password_required";
          login.error = hint ? `2FA password required (${hint})` : "2FA password required";
          throw new Error("telegram_password_required");
        },
        onError: async (err) => {
          login.status = "error";
          login.error = err instanceof Error ? err.message : String(err);
          login.rejectFirstQr?.(err);
          return true;
        },
      },
    );

    login.status = "confirmed";
    login.session = login.client.session.save();
    login.account = {
      provider_user_id: user?.id?.toString?.() || "",
      display_name: [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.username || "Telegram",
      username: user?.username || "",
      phone_masked: maskPhone(user?.phone || ""),
    };
  } catch (err) {
    if (login.status !== "password_required") {
      login.status = "error";
      login.error = err instanceof Error ? err.message : String(err);
    }
    login.rejectFirstQr?.(err);
    safeDisconnect(login.client);
  }
}

async function handleNewMessage(listener, event) {
  const message = event?.message;
  if (!message || message.id == null) return;
  const providerChatId = await providerChatIdForMessage(listener.client, message);
  if (!providerChatId) return;
  await postJSON(listener.callbackUrl, {
    account_id: listener.accountId,
    provider_chat_id: providerChatId,
    message: messageToItem(message),
  }, listener.callbackSecret);
}

async function providerChatIdForMessage(client, message) {
  const rawId = stringifyId(message.chatId || message.peerId?.channelId || message.peerId?.chatId || message.peerId?.userId);
  if (!rawId) return "";
  const dialogs = await client.getDialogs({ limit: 500 });
  const dialog = dialogs.find((item) => {
    const dialogID = stringifyId(item.id || item.entity?.id);
    const entityID = stringifyId(item.entity?.id);
    return dialogID === rawId || entityID === rawId;
  });
  return dialog ? stringifyId(dialog.id || dialog.entity?.id) : rawId;
}

async function postJSON(url, payload, secret) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Toolkit-Telegram-Secret": secret,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => "");
    throw new Error(`callback HTTP ${res.status}: ${text}`);
  }
}

async function stopUpdateClient(accountId) {
  const existing = updateClients.get(accountId);
  if (!existing) return;
  updateClients.delete(accountId);
  safeDisconnect(existing.client);
}

function messageToItem(message) {
  if (!message || message.id == null) return null;
  const sentAt = message.date ? new Date(Number(message.date) * 1000).toISOString() : new Date().toISOString();
  const text = message.message || message.text || mediaPreview(message) || "";
  return {
    provider_message_id: stringifyId(message.id),
    direction: message.out ? "out" : "in",
    sender_provider_id: stringifyId(message.senderId || message.fromId?.userId || message.peerId?.userId),
    sender_name: "",
    text: previewText(text, 4000),
    status: "sent",
    sent_at: sentAt,
    attachments: extractAttachments(message),
    raw: {
      id: stringifyId(message.id),
      out: Boolean(message.out),
      media: message.media?.className || "",
    },
  };
}

function extractAttachments(message) {
  const media = message?.media;
  if (!media) return [];
  const document = message.document || media.document;
  const photo = message.photo || media.photo;
  if (photo) {
    const sizes = Array.isArray(photo.sizes) ? photo.sizes : [];
    const best = sizes.find((item) => item?.w && item?.h) || {};
    return [{
      provider_file_id: stringifyId(photo.id || message.id),
      kind: "photo",
      file_name: `photo-${stringifyId(message.id)}.jpg`,
      mime_type: "image/jpeg",
      size_bytes: numberOrNull(best.size),
      width: numberOrNull(best.w),
      height: numberOrNull(best.h),
    }];
  }
  if (!document) return [];
  const attrs = Array.isArray(document.attributes) ? document.attributes : [];
  const filenameAttr = attrs.find((attr) => attr?.fileName);
  const audioAttr = attrs.find((attr) => String(attr?.className || "").includes("Audio"));
  const videoAttr = attrs.find((attr) => String(attr?.className || "").includes("Video"));
  const stickerAttr = attrs.find((attr) => String(attr?.className || "").includes("Sticker"));
  const mimeType = document.mimeType || "";
  let kind = "document";
  if (stickerAttr) kind = "sticker";
  else if (audioAttr?.voice) kind = "voice";
  else if (mimeType.startsWith("audio/") || audioAttr) kind = "audio";
  else if (mimeType.startsWith("video/") || videoAttr) kind = "video";
  const fileName = filenameAttr?.fileName || defaultFileName(kind, mimeType, message.id);
  return [{
    provider_file_id: stringifyId(document.id || message.id),
    kind,
    file_name: fileName,
    mime_type: mimeType || "application/octet-stream",
    size_bytes: numberOrNull(document.size),
    width: numberOrNull(videoAttr?.w),
    height: numberOrNull(videoAttr?.h),
    duration_sec: numberOrNull(audioAttr?.duration || videoAttr?.duration),
  }];
}

function defaultFileName(kind, mimeType, messageId) {
  const ext = mimeType.includes("/") ? mimeType.split("/").pop().replace(/[^a-z0-9]+/gi, "") : "";
  const cleanExt = ext ? `.${ext}` : "";
  return `${kind || "file"}-${stringifyId(messageId)}${cleanExt}`;
}

function numberOrNull(value) {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function mediaPreview(message) {
  const media = message.media;
  if (!media) return "";
  const className = media.className || "";
  if (className.includes("Photo")) return "Фото";
  if (className.includes("Document")) return "Файл";
  if (className.includes("WebPage")) return "Ссылка";
  return "Вложение";
}

function dialogToChat(dialog) {
  const entity = dialog.entity || {};
  const className = entity.className || entity.CONSTRUCTOR_ID || "";
  const isUser = className === "User" || Boolean(entity.firstName || entity.lastName || entity.username);
  const isBot = Boolean(entity.bot);
  const isMegagroup = Boolean(entity.megagroup);
  const isBroadcast = Boolean(entity.broadcast);
  const isChat = className === "Chat";
  const isChannel = className === "Channel" || isMegagroup || isBroadcast;

  let type = "unknown";
  if (isUser && !isBot) type = "private";
  else if (isChat || (isChannel && isMegagroup)) type = "group";
  else if (isChannel && isBroadcast) type = "channel";
  else if (isBot) type = "bot";

  const title = dialog.title || entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(" ") || entity.username || "Без названия";
  const message = dialog.message || {};
  const messageText = message.message || message.text || mediaPreview(message) || "";
  const date = message.date ? new Date(Number(message.date) * 1000).toISOString() : undefined;

  return {
    provider_chat_id: stringifyId(dialog.id || entity.id),
    type,
    title,
    unread_count: Number(dialog.unreadCount || 0),
    last_message_preview: previewText(messageText),
    last_message_at: date,
    pinned: Boolean(dialog.pinned),
    muted: Boolean(dialog.notifySettings?.muteUntil && Number(dialog.notifySettings.muteUntil) > Date.now() / 1000),
  };
}

function stringifyId(value) {
  if (value == null) return "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "string") return String(value);
  if (typeof value.toString === "function") return value.toString();
  return "";
}

function previewText(value, max = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function toPublicLogin(login) {
  return {
    login_id: login.id,
    status: login.status,
    qr_payload: login.qrPayload,
    qr_image: login.qrImage,
    expires_at: login.expiresAt.toISOString(),
    error: login.error || undefined,
    session: login.status === "confirmed" ? login.session : undefined,
    account: login.status === "confirmed" ? login.account : undefined,
  };
}

function maskPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 4) return "";
  return `+${digits.slice(0, 3)}******${digits.slice(-2)}`;
}

function safeDisconnect(client) {
  try {
    void client?.disconnect?.();
  } catch {
    // noop
  }
}

app.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", msg: "telegram-worker listening", port }));
});
