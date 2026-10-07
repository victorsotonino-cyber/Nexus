const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, ChannelType
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN || "";
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const PORT = Number(process.env.PORT || 3000);
const PREFIX = (process.env.PREFIX || "vouch").toLowerCase();

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "vouches.json");

function loadData() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ guilds: {} }, null, 2));
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (error) {
    console.error("No se pudo cargar la base local:", error);
    return { guilds: {} };
  }
}

let data = loadData();

function saveData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getGuildData(guildId) {
  if (!data.guilds[guildId]) data.guilds[guildId] = { outputChannelId: null, vouches: {} };
  return data.guilds[guildId];
}

function addVouch(guildId, userId) {
  const guildData = getGuildData(guildId);
  guildData.vouches[userId] = (guildData.vouches[userId] || 0) + 1;
  saveData();
  return guildData.vouches[userId];
}

function getTotal(guildId, userId) {
  return getGuildData(guildId).vouches[userId] || 0;
}

function buildVouchEmbed(target, giver, total) {
  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle("📊 Vouch Registrado")
    .setDescription([
      "✅ Se ha registrado un vouch exitosamente para " + target + ".",
      "",
      "👤 Otorgado por: " + giver,
      "",
      "📊 Total actual: **" + total + " vouch(es)**."
    ].join("\n"))
    .setTimestamp();
}

async function resolveOutputChannel(guild) {
  const id = getGuildData(guild.id).outputChannelId;
  if (!id) return null;
  const channel = await guild.channels.fetch(id).catch(() => null);
  return channel && channel.isTextBased() ? channel : null;
}

const slashCommands = [
  new SlashCommandBuilder()
    .setName("vouch")
    .setDescription("Registra un vouch para un usuario.")
    .addUserOption(o => o.setName("usuario").setDescription("Usuario que recibe el vouch.").setRequired(true))
    .addStringOption(o => o.setName("servicio").setDescription("Servicio o producto (opcional).").setRequired(false)),
  new SlashCommandBuilder()
    .setName("vouchchannel")
    .setDescription("Configura dónde se publican los vouches.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName("set").setDescription("Elige el canal de vouches.")
      .addChannelOption(o => o.setName("canal").setDescription("Canal de texto.").addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(s => s.setName("off").setDescription("Desactiva los vouches."))
    .addSubcommand(s => s.setName("ver").setDescription("Muestra el canal configurado.")),
  new SlashCommandBuilder()
    .setName("vouchstats")
    .setDescription("Muestra los vouches de un usuario.")
    .addUserOption(o => o.setName("usuario").setDescription("Usuario a consultar.").setRequired(true))
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

async function registerCommands() {
  if (!TOKEN || !CLIENT_ID) {
    console.warn("Bot en modo dashboard: no se registran comandos slash.");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const body = slashCommands.map(c => c.toJSON());
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
    console.log("Comandos slash registrados en el servidor " + GUILD_ID);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
    console.log("Comandos slash registrados globalmente.");
  }
}

client.once("ready", async () => {
  console.log("Nexus conectado como " + client.user.tag);
  client.user.setActivity("/vouch", { type: 0 });
  try { await registerCommands(); } catch (error) { console.error("Error registrando comandos:", error); }
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  if (interaction.commandName === "vouch") {
    const outputChannel = await resolveOutputChannel(interaction.guild);
    if (!outputChannel) return interaction.reply({ content: "❌ No hay un canal configurado. Usa /vouchchannel set.", ephemeral: true });
    const target = interaction.options.getUser("usuario", true);
    if (target.bot) return interaction.reply({ content: "❌ No puedes dar un vouch a un bot.", ephemeral: true });
    if (target.id === interaction.user.id) return interaction.reply({ content: "❌ No puedes darte un vouch a ti mismo.", ephemeral: true });
    const total = addVouch(interaction.guild.id, target.id);
    await outputChannel.send({ embeds: [buildVouchEmbed("<@" + target.id + ">", "<@" + interaction.user.id + ">", total)] });
    return interaction.reply({ content: "✅ Vouch registrado.", ephemeral: true });
  }

  if (interaction.commandName === "vouchchannel") {
    const sub = interaction.options.getSubcommand();
    const guildData = getGuildData(interaction.guild.id);
    if (sub === "set") {
      const channel = interaction.options.getChannel("canal", true);
      guildData.outputChannelId = channel.id;
      saveData();
      return interaction.reply({ content: "✅ Los vouches se publicarán en <#" + channel.id + ">.", ephemeral: true });
    }
    if (sub === "off") {
      guildData.outputChannelId = null;
      saveData();
      return interaction.reply({ content: "✅ Canal de vouches desactivado.", ephemeral: true });
    }
    if (!guildData.outputChannelId) return interaction.reply({ content: "ℹ️ No hay ningún canal de vouches configurado.", ephemeral: true });
    return interaction.reply({ content: "📊 Canal actual: <#" + guildData.outputChannelId + ">", ephemeral: true });
  }

  if (interaction.commandName === "vouchstats") {
    const user = interaction.options.getUser("usuario", true);
    return interaction.reply({
      content: "📊 " + user + " tiene **" + getTotal(interaction.guild.id, user.id) + " vouch(es)**.",
      ephemeral: true
    });
  }
});

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;
  const content = message.content.trim();
  if (!content.toLowerCase().startsWith(PREFIX + " ")) return;
  const outputChannel = await resolveOutputChannel(message.guild);
  if (!outputChannel) return message.reply("❌ No hay un canal de vouches configurado. Un administrador debe usar /vouchchannel set.");
  const target = message.mentions.members.first();
  if (!target) return message.reply("❌ Usa: " + PREFIX + " @usuario o " + PREFIX + " servicio @usuario");
  if (target.user.bot) return message.reply("❌ No puedes dar un vouch a un bot.");
  if (target.user.id === message.author.id) return message.reply("❌ No puedes darte un vouch a ti mismo.");
  const total = addVouch(message.guild.id, target.user.id);
  await outputChannel.send({ embeds: [buildVouchEmbed("<@" + target.user.id + ">", "<@" + message.author.id + ">", total)] });
});

client.on("error", error => console.error("Discord client error:", error));

const dashboardSessions = new Map();
const DASHBOARD_DIR = path.join(__dirname, "dashboard");
const DASHBOARD_DATA = path.join(DATA_DIR, "dashboard.json");

function loadDashboardData() {
  try {
    if (!fs.existsSync(DASHBOARD_DATA)) fs.writeFileSync(DASHBOARD_DATA, JSON.stringify({ guilds: {} }, null, 2));
    return JSON.parse(fs.readFileSync(DASHBOARD_DATA, "utf8"));
  } catch { return { guilds: {} }; }
}
let dashboardData = loadDashboardData();
function saveDashboardData() { fs.writeFileSync(DASHBOARD_DATA, JSON.stringify(dashboardData, null, 2)); }
function getDashboardGuild(guildId) {
  if (!dashboardData.guilds[guildId]) dashboardData.guilds[guildId] = {
    ticketCategory: "", ticketStaffRole: "", ticketLimit: "2", modLogChannel: "",
    staffPostChannel: "", alterPostChannel: "", vouchChannel: "", ticketLogChannel: "",
    staffRole: "", helperRole: "", alterRole: ""
  };
  return dashboardData.guilds[guildId];
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function session(req) {
  const id = cookies(req).nexus_session;
  return id ? dashboardSessions.get(id) : null;
}
async function discordOAuthToken(code) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: process.env.DISCORD_CLIENT_SECRET || "",
    grant_type: "authorization_code",
    code,
    redirect_uri: (process.env.DASHBOARD_URL || "").replace(/\/$/, "") + "/auth/discord/callback"
  });
  const r = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) throw new Error("OAuth token error " + r.status);
  return r.json();
}
async function discordGet(pathname, token) {
  const r = await fetch("https://discord.com/api" + pathname, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("Discord API " + r.status);
  return r.json();
}
function canManageGuild(g) {
  return Boolean(g.owner || ((Number(g.permissions) & 0x20) === 0x20));
}

const server = http.createServer(async (req, res) => {
  try {
    const base = process.env.DASHBOARD_URL || "http://localhost:" + PORT;
    const url = new URL(req.url, base);

    if (url.pathname === "/auth/discord") {
      if (!CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET || !process.env.DASHBOARD_URL) {
        return json(res, 500, { error: "Configura CLIENT_ID, DISCORD_CLIENT_SECRET y DASHBOARD_URL." });
      }
      const redirect = encodeURIComponent(process.env.DASHBOARD_URL.replace(/\/$/, "") + "/auth/discord/callback");
      return res.writeHead(302, {
        Location: "https://discord.com/oauth2/authorize?client_id=" + encodeURIComponent(CLIENT_ID) +
          "&response_type=code&redirect_uri=" + redirect + "&scope=identify%20guilds"
      }).end();
    }

    if (url.pathname === "/auth/discord/callback") {
      const code = url.searchParams.get("code");
      if (!code) return res.writeHead(400).end("Falta el código OAuth2.");
      const token = await discordOAuthToken(code);
      const user = await discordGet("/users/@me", token.access_token);
      const id = crypto.randomUUID();
      dashboardSessions.set(id, { user, accessToken: token.access_token, created: Date.now() });
      res.writeHead(302, {
        "Set-Cookie": "nexus_session=" + encodeURIComponent(id) + "; HttpOnly; Path=/; SameSite=Lax",
        Location: "/"
      }).end();
      return;
    }

    if (url.pathname === "/auth/logout") {
      const sid = cookies(req).nexus_session;
      if (sid) dashboardSessions.delete(sid);
      res.writeHead(302, {
        "Set-Cookie": "nexus_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
        Location: "/"
      }).end();
      return;
    }

    if (url.pathname === "/api/me") {
      const s = session(req);
      return json(res, 200, s ? { authenticated: true, user: s.user } : { authenticated: false });
    }

    const s = session(req);
    if (url.pathname === "/api/guilds") {
      if (!s) return json(res, 401, { error: "No autenticado" });
      const guilds = (await discordGet("/users/@me/guilds", s.accessToken)).filter(canManageGuild);
      return json(res, 200, guilds);
    }

    const cfgMatch = url.pathname.match(/^\/api\/config\/([0-9]+)$/);
    if (cfgMatch) {
      if (!s) return json(res, 401, { error: "No autenticado" });
      const guilds = (await discordGet("/users/@me/guilds", s.accessToken)).filter(canManageGuild);
      if (!guilds.some(g => g.id === cfgMatch[1])) return json(res, 403, { error: "No administras ese servidor." });
      const guildId = cfgMatch[1];
      if (req.method === "GET") return json(res, 200, { config: getDashboardGuild(guildId) });
      if (req.method === "POST") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const incoming = JSON.parse(raw || "{}");
        const allowed = Object.keys(getDashboardGuild(guildId));
        const cfg = getDashboardGuild(guildId);
        for (const key of allowed) if (typeof incoming[key] === "string") cfg[key] = incoming[key].slice(0, 300);
        saveDashboardData();
        return json(res, 200, { ok: true, config: cfg });
      }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = fs.readFileSync(path.join(DASHBOARD_DIR, "public", "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Nexus Dashboard: 404");
  } catch (error) {
    console.error("Dashboard error:", error);
    json(res, 500, { error: "Error interno del dashboard." });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log("Nexus Dashboard online en puerto " + PORT));

if (TOKEN) {
  client.login(TOKEN).catch(error => {
    console.error("No se pudo iniciar sesión en Discord:", error);
    process.exit(1);
  });
} else {
  console.log("Dashboard iniciado sin DISCORD_TOKEN. El bot permanece apagado en este servicio.");
}
