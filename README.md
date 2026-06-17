# VitalHub · Servidor WhatsApp não-oficial (Baileys)

Servidor que conecta um número de WhatsApp **comum** (via QR code) e integra com o seu CRM:

- Envia mensagens chamadas pelo CRM (`POST /send`)
- Recebe respostas e grava no Supabase → aparecem na aba **Conversas**
- Página `/qr` para parear o número

> ⚠️ **Aviso importante.** Isto automatiza o WhatsApp comum, o que **viola os termos do WhatsApp**. Para **prospecção fria em massa o risco de banimento do número é ALTO**. Use **um chip dedicado** (nunca seu número pessoal), **aqueça devagar** e mantenha um atraso entre envios (`MIN_DELAY_MS`). Use por sua conta e risco.

---

## Passo a passo — Deploy no Railway

### 1. Suba este código para um repositório no GitHub
Crie um repositório novo (ex: `vitalhub-wa-server`) e suba **a pasta `whatsapp-server/`** (os arquivos `package.json`, `server.js`, etc. devem ficar na **raiz** do repositório).

### 2. Crie o projeto no Railway
1. Acesse **railway.app** → **New Project** → **Deploy from GitHub repo**
2. Selecione o repositório que você criou
3. O Railway detecta o Node.js e instala sozinho (`npm install` + `npm start`)

### 3. Adicione um Volume (essencial para não perder a sessão)
Sem isso, o número **desconecta a cada reinício** e você teria que escanear o QR de novo.
1. No projeto Railway → aba **Variables** ao lado, clique no serviço → **Settings** → **Volumes**
2. **Add Volume** → Mount path: **`/app/auth`**

### 4. Configure as variáveis de ambiente
No serviço → aba **Variables** → adicione (veja `.env.example`):

| Variável | Valor |
|---|---|
| `API_TOKEN` | uma senha forte que você inventa (guarde — vai no CRM) |
| `SUPABASE_URL` | a URL do seu projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | a **service_role key** (Supabase → Settings → API) |
| `AUTH_DIR` | `/app/auth` |
| `MIN_DELAY_MS` | `8000` (8s entre envios — recomendado) |

> A **service_role key** é secreta e dá acesso total ao banco — só use aqui no servidor, nunca no site.

### 5. Gere o domínio público
1. Serviço → **Settings** → **Networking** → **Generate Domain**
2. Copie a URL (ex: `https://vitalhub-wa-server-production.up.railway.app`)

### 6. Conecte o número (escaneie o QR)
1. Abra `SUA_URL/qr` no navegador
2. No celular do **chip dedicado**: WhatsApp → **Aparelhos conectados** → **Conectar um aparelho** → escaneie
3. A página mostra **✅ Conectado** quando parear

### 7. Ligue no CRM
No CRM → **Configurações → WhatsApp → Conexão não-oficial (Baileys)**:
- **URL do servidor:** a URL do Railway
- **Token:** o mesmo `API_TOKEN`
- Salve e teste

Pronto — os envios passam pelo seu número, e as respostas caem na aba **Conversas**.

---

## Endpoints

| Método | Rota | Função |
|---|---|---|
| `GET` | `/` | health check + estado |
| `GET` | `/status` | `{ connected, state, me }` |
| `GET` | `/qr` | página visual com o QR |
| `POST` | `/send` | body `{ "to": "5534999998888", "text": "..." }` — header `x-api-token` |
| `POST` | `/logout` | desconecta o número (para trocar de chip) |

---

## Rodar localmente (teste)

```bash
cd whatsapp-server
cp .env.example .env   # edite os valores
npm install
node --env-file=.env server.js
# abra http://localhost:3000/qr
```

---

## Boas práticas anti-ban (leia)
- **Chip dedicado**, novo, com um perfil preenchido (foto + nome).
- **Aqueça:** poucos envios/dia na 1ª semana, aumentando aos poucos.
- **Atraso entre envios:** mantenha `MIN_DELAY_MS` em 8–15s.
- **Evite texto idêntico** em massa — varie as mensagens.
- **Respeite quem pede para parar** (o CRM já tem opt-out).
- Tenha um **plano B**: se o número cair, a API oficial continua para o 1º contato.
