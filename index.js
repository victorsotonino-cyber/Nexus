
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, ChannelType
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const PORT = Number(process.env.PORT || 3000);
const PREFIX = (process.env.PREFIX || "vouch").toLowerCase();

if (!TOKEN) {
  console.error("Falta DISCORD_TOKEN en las variables de entorno.");
  process.exit(1);
}

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
  if (!CLIENT_ID) {
    console.warn("CLIENT_ID no está configurado; no se registrarán comandos slash.");
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
    if (!outputChannel) {
      return interaction.reply({ content: "❌ No hay un canal configurado. Usa /vouchchannel set.", ephemeral: true });
    }

    const target = interaction.options.getUser("usuario", true);
    if (target.bot) return interaction.reply({ content: "❌ No puedes dar un vouch a un bot.", ephemeral: true });
    if (target.id === interaction.user.id) return interaction.reply({ content: "❌ No puedes darte un vouch a ti mismo.", ephemeral: true });

    const total = addVouch(interaction.guild.id, target.id);
    await outputChannel.send({
      embeds: [buildVouchEmbed("<@" + target.id + ">", "<@" + interaction.user.id + ">", total)]
    });
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

    if (!guildData.outputChannelId) {
      return interaction.reply({ content: "ℹ️ No hay ningún canal de vouches configurado.", ephemeral: true });
    }
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
  if (!outputChannel) {
    return message.reply("❌ No hay un canal de vouches configurado. Un administrador debe usar /vouchchannel set.");
  }

  const target = message.mentions.members.first();
  if (!target) return message.reply("❌ Usa: " + PREFIX + " @usuario o " + PREFIX + " servicio @usuario");
  if (target.user.bot) return message.reply("❌ No puedes dar un vouch a un bot.");
  if (target.user.id === message.author.id) return message.reply("❌ No puedes darte un vouch a ti mismo.");

  const total = addVouch(message.guild.id, target.user.id);
  await outputChannel.send({
    embeds: [buildVouchEmbed("<@" + target.user.id + ">", "<@" + message.author.id + ">", total)]
  });
});

client.on("error", error => console.error("Discord client error:", error));

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Nexus Vouch Bot online.");
});

server.listen(PORT, "0.0.0.0", () => console.log("Health server en puerto " + PORT));

client.login(TOKEN).catch(error => {
  console.error("No se pudo iniciar sesión en Discord:", error);
  process.exit(1);
});
