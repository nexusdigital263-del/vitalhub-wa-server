// ============================================================================
//  VitalHub · Servidor WhatsApp NÃO-OFICIAL (Baileys)
//  ------------------------------------------------------------------------
//  Conecta um número de WhatsApp comum (via QR code) e:
//   • expõe /qr  → página com o QR para parear o número
//   • expõe /status → estado da conexão
//   • expõe /send → envia mensagem (texto) — usado pelo CRM
//   • recebe mensagens e grava no Supabase (mesma tabela `leads`),
//     para aparecerem na aba Conversas do CRM, como na API oficial.
//
//  ⚠️ Uso por sua conta e risco. Automação não-oficial viola os termos do
//     WhatsApp; para prospecção fria em massa o risco de BAN é ALTO.
// ============================================================================

import express from "express";
import pino from "pino";
import qrcode from "qrcode";
import { createClient } from "@supabase/supabase-js";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { rm, readdir } from "fs/promises";
import { join } from "path";

// ---- Config (variáveis de ambiente) ----------------------------------------
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || "";              // segredo p/ o CRM chamar /send
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const AUTH_DIR = process.env.AUTH_DIR || "./auth";          // pasta da sessão (use um Volume no Railway!)
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || 0); // atraso mínimo entre envios (anti-ban)

const log = pino({ level: "info" });
const sb = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

// limpa o CONTEÚDO da pasta de sessão (não a pasta em si — é o mount do volume)
async function clearAuth() {
  try {
    const entries = await readdir(AUTH_DIR).catch(() => []);
    await Promise.all(entries.map((name) => rm(join(AUTH_DIR, name), { recursive: true, force: true })));
    log.warn("🧹 sessão limpa (" + entries.length + " itens em " + AUTH_DIR + ")");
  } catch (e) { log.error(e, "falha ao limpar sessão"); }
}

// ---- Estado da conexão ------------------------------------------------------
let sock = null;
let qrDataUrl = null;     // QR atual (data URL) para a página /qr
let connState = "starting"; // starting | qr | open | close
let lastConnectedAt = null;
let meNumber = null;
let lastSendAt = 0;

// ---- Helpers de telefone ----------------------------------------------------
function digits(s) { return String(s || "").replace(/\D/g, ""); }
function toJid(phone) {
  let d = digits(phone);
  if (!d) return null;
  if (d.length <= 11) d = "55" + d; // DDI Brasil se faltar
  return d + "@s.whatsapp.net";
}
function fromJid(jid) {
  const d = digits((jid || "").split("@")[0]);
  return d;
}

// ============================================================================
//  Supabase: gravar mensagem recebida no lead correspondente
// ============================================================================
async function saveIncoming(phone, text, tsMs) {
  if (!sb) { log.warn("Supabase não configurado — mensagem recebida não foi gravada"); return; }
  const d = digits(phone);
  // tenta casar pelos últimos 8 dígitos (ignora DDI/9º dígito)
  const tail = d.slice(-8);
  try {
    const { data: leads, error } = await sb.from("leads").select("id, whatsapp, interacoes, unread, empresa");
    if (error) { log.error(error, "erro lendo leads"); return; }
    let target = null;
    for (const l of (leads || [])) {
      const ld = digits(l.whatsapp);
      if (ld && (ld === d || ld.slice(-8) === tail)) { target = l; break; }
    }
    const it = {
      id: "in-" + Date.now() + "-" + Math.random().toString(16).slice(2, 6),
      data: new Date().toISOString().slice(0, 10),
      ts: tsMs || Date.now(),
      tipo: "WhatsApp",
      nota: text,
      dir: "in",
      canal: "nao-oficial",
    };
    if (target) {
      const arr = Array.isArray(target.interacoes) ? target.interacoes : [];
      arr.push(it);
      const unread = (target.unread || 0) + 1;
      await sb.from("leads").update({ interacoes: arr, unread }).eq("id", target.id);
      log.info(`📥 resposta de ${target.empresa || d} gravada`);
    } else {
      // sem lead correspondente: cria um lead novo "Inbound" para não perder a conversa
      const novo = {
        empresa: "Novo contato " + d.slice(-4),
        whatsapp: d,
        segmento: "Outros",
        status: "Em Contato",
        cidade: "",
        responsavel: "",
        interacoes: [it],
        unread: 1,
        origem: "whatsapp-inbound",
      };
      const { error: insErr } = await sb.from("leads").insert(novo);
      if (insErr) log.error(insErr, "erro criando lead inbound");
      else log.info(`📥 nova conversa de ${d} criada`);
    }
  } catch (e) {
    log.error(e, "saveIncoming falhou");
  }
}

// ============================================================================
//  Baileys: conexão + QR + reconexão
// ============================================================================
async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "22.04.4"],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 2000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      connState = "qr";
      try { qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 }); } catch {}
      log.info("📱 QR atualizado — abra /qr para escanear");
    }
    if (connection === "open") {
      connState = "open";
      qrDataUrl = null;
      lastConnectedAt = new Date().toISOString();
      meNumber = fromJid(sock?.user?.id);
      log.info(`✅ conectado como ${meNumber}`);
    }
    if (connection === "close") {
      connState = "close";
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      const badSession = code === DisconnectReason.badSession;
      const conflict = code === DisconnectReason.connectionReplaced || code === 440;
      log.warn(`conexão fechada (code ${code}) — ${loggedOut ? "deslogado" : badSession ? "sessão inválida, limpando…" : conflict ? "conexão substituída (aberto em outro lugar)" : "reconectando…"}`);
      qrDataUrl = null;
      // Só limpa os creds quando REALMENTE inválido (logout ou badSession).
      // Demais quedas (timeout, restart, rede) = reconecta mantendo a sessão.
      if (loggedOut || badSession) {
        await clearAuth();
        setTimeout(() => startSocket().catch((e) => log.error(e)), 4000);
      } else if (conflict) {
        // outro WhatsApp Web assumiu a sessão — espera mais p/ não brigar
        setTimeout(() => startSocket().catch((e) => log.error(e)), 15000);
      } else {
        setTimeout(() => startSocket().catch((e) => log.error(e)), 5000);
      }
    }
  });

  // mensagens recebidas
  sock.ev.on("messages.upsert", async (m) => {
    try {
      if (m.type !== "notify") return;
      for (const msg of m.messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid || "";
        if (jid.endsWith("@g.us")) continue; // ignora grupos
        const phone = fromJid(jid);
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          (msg.message.imageMessage ? "[imagem]" : "") ||
          (msg.message.documentMessage ? "[documento]" : "") ||
          (msg.message.audioMessage ? "[áudio]" : "") ||
          "";
        if (!text) continue;
        const tsMs = (Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;
        await saveIncoming(phone, text, tsMs);
      }
    } catch (e) {
      log.error(e, "erro processando messages.upsert");
    }
  });
}

// ============================================================================
//  Envio (com atraso anti-ban opcional)
// ============================================================================
async function sendText(phone, text) {
  if (connState !== "open" || !sock) throw new Error("WhatsApp não conectado — escaneie o QR em /qr");
  const jid = toJid(phone);
  if (!jid) throw new Error("Número inválido");
  // confere se o número existe no WhatsApp
  try {
    const [res] = await sock.onWhatsApp(jid);
    if (!res || !res.exists) throw new Error("Número não tem WhatsApp");
  } catch (e) {
    if (/não tem WhatsApp/.test(e.message)) throw e;
    // se a checagem falhar por outro motivo, segue tentando enviar
  }
  // respeita atraso mínimo entre envios
  const wait = MIN_DELAY_MS - (Date.now() - lastSendAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const sent = await sock.sendMessage(jid, { text });
  lastSendAt = Date.now();
  return sent?.key?.id || null;
}

// ============================================================================
//  HTTP API
// ============================================================================
const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS liberado (o CRM roda em outro domínio)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-token");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function checkToken(req, res) {
  if (!API_TOKEN) return true; // sem token configurado = aberto (NÃO recomendado em produção)
  const t = req.headers["x-api-token"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (t !== API_TOKEN) { res.status(401).json({ error: "Token inválido" }); return false; }
  return true;
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "vitalhub-wa-server", state: connState, me: meNumber });
});

app.get("/status", (req, res) => {
  res.json({ connected: connState === "open", state: connState, me: meNumber, lastConnectedAt, hasQR: !!qrDataUrl });
});

// página visual com o QR (auto-atualiza a cada 6s)
app.get("/qr", (req, res) => {
  const body = connState === "open"
    ? `<div class="ok">✅ Conectado como <b>${meNumber || ""}</b></div>`
    : qrDataUrl
      ? `<img src="${qrDataUrl}" alt="QR" /><p>Abra o WhatsApp → <b>Aparelhos conectados</b> → <b>Conectar um aparelho</b> e escaneie.</p>`
      : `<div class="wait">Gerando QR… aguarde alguns segundos e a página atualiza sozinha.</div>`;
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VitalHub · Conectar WhatsApp</title>
<meta http-equiv="refresh" content="6">
<style>
  body{font-family:system-ui,sans-serif;background:#0E130D;color:#E9EBD8;display:flex;
       min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center}
  .card{background:#151B13;border:1px solid rgba(224,226,196,.12);border-radius:16px;padding:32px;max-width:380px}
  h1{font-size:20px;margin:0 0 6px} .sub{color:#AAB39C;font-size:13px;margin-bottom:20px}
  img{width:300px;height:300px;border-radius:10px;background:#fff;padding:8px}
  p{color:#AAB39C;font-size:13px;line-height:1.5} .ok{font-size:18px;color:#25D366}
  .wait{color:#AAB39C}
</style></head><body><div class="card">
  <h1>VitalHub · WhatsApp</h1>
  <div class="sub">Conexão não-oficial (Baileys)</div>
  ${body}
</div></body></html>`);
});

// envio (usado pelo CRM)
app.post("/send", async (req, res) => {
  if (!checkToken(req, res)) return;
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: "Informe 'to' e 'text'" });
  try {
    const id = await sendText(to, text);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message || String(e) });
  }
});

// desconectar / trocar de número
app.post("/logout", async (req, res) => {
  if (!checkToken(req, res)) return;
  try { await sock?.logout(); } catch {}
  res.json({ ok: true });
});

app.listen(PORT, () => {
  log.info(`🚀 servidor na porta ${PORT}`);
  startSocket().catch((e) => log.error(e, "falha ao iniciar Baileys"));
});
