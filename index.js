import { Client, GatewayIntentBits, Routes, REST, EmbedBuilder } from "discord.js";
import "dotenv/config";
import LibertyTools from "./liberty-tools/index.js";

const LT = new LibertyTools({
    SERVER_KEY: process.env.PRIVATE_SERVER_KEY,
});

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_BOT_ID = process.env.DISCORD_BOT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const modRole = process.env.MODERATOR_ROLE;

if (!DISCORD_BOT_TOKEN || !DISCORD_BOT_ID || !DISCORD_GUILD_ID) {
    throw new Error("You must provide a DISCORD_BOT_TOKEN, DISCORD_BOT_ID, and DISCORD_GUILD_ID in a .env file");
}

if (!modRole) {
    console.warn("You did not provide a MODERATOR_ROLE in the .env file, commands that require this role will not work.");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ===== COMMANDS =====
const commands = [
    {
        name: "ping",
        description: "Replies with Pong!",
        type: 1,
    },
    {
        name: "erlc-ban",
        description: "Bans a user from the ERLC Private Server",
        type: 1,
        options: [
            {
                type: 4,
                name: "userid",
                description: "The Roblox user ID you want to ban",
                required: true,
            },
        ],
    },
    {
        name: "erlc-kick",
        description: "Kicks a user from the ERLC Private Server",
        type: 1,
        options: [
            {
                type: 4,
                name: "userid",
                description: "The Roblox user ID you want to kick",
                required: true,
            },
        ],
    },
    {
        // Fix: command was handled but never registered
        name: "erlc-information",
        description: "Gets information about the ERLC Private Server",
        type: 1,
    },
];

// Fix: use DISCORD_BOT_TOKEN instead of undefined TOKEN
const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

// Helper: check if a member has the mod role
function isModerator(interaction) {
    if (!modRole) return false;
    return interaction.member.roles.cache.has(modRole);
}

let serverInfo = null;

client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);

    // Fix: initialize serverInfo inside ready before interval starts
    try {
        serverInfo = await LT.getPrivateServerAPI("");
    } catch (err) {
        console.error("Failed to fetch initial server info:", err);
    }

    // Refresh server info every 3 seconds
    setInterval(async () => {
        try {
            serverInfo = await LT.getPrivateServerAPI("");
        } catch (err) {
            console.error("Failed to refresh server info:", err);
        }
    }, 3000);

    // Fix: use DISCORD_BOT_ID and DISCORD_GUILD_ID instead of undefined CLIENT_ID / GUILD_ID
    try {
        await rest.put(
            Routes.applicationGuildCommands(DISCORD_BOT_ID, DISCORD_GUILD_ID),
            { body: commands }
        );
        console.log("Slash commands registered successfully.");
    } catch (err) {
        console.error("Failed to register slash commands:", err);
    }
});

// ===== HANDLE COMMANDS =====
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "ping") {
        await interaction.reply("🏓 Pong!");
    }

    else if (interaction.commandName === "erlc-ban") {
        if (!isModerator(interaction)) {
            return interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
        }

        // Fix: defer reply before async API call to avoid Discord 3s timeout
        await interaction.deferReply();

        const userID = interaction.options.getInteger("userid");

        try {
            const apiRes = await LT.sendPrivateServerCommand(JSON.stringify({ command: `:ban ${userID}` }));
            if (apiRes.error === undefined) {
                await interaction.editReply(`✅ User ID ${userID} has been banned: https://www.roblox.com/users/${userID}/profile`);
            } else {
                await interaction.editReply("❌ I encountered an error trying to ban this user. Please try again later.");
            }
        } catch (err) {
            console.error("erlc-ban error:", err);
            await interaction.editReply("❌ An unexpected error occurred. Please try again later.");
        }
    }

    else if (interaction.commandName === "erlc-kick") {
        if (!isModerator(interaction)) {
            return interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
        }

        // Fix: defer reply before async API call
        await interaction.deferReply();

        const userID = interaction.options.getInteger("userid");

        try {
            const apiRes = await LT.sendPrivateServerCommand(JSON.stringify({ command: `:kick ${userID}` }));
            if (apiRes.error === undefined) {
                await interaction.editReply(`✅ User ID ${userID} has been kicked: https://www.roblox.com/users/${userID}/profile`);
            } else {
                await interaction.editReply("❌ I encountered an error trying to kick this user. Please try again later.");
            }
        } catch (err) {
            console.error("erlc-kick error:", err);
            await interaction.editReply("❌ An unexpected error occurred. Please try again later.");
        }
    }

    else if (interaction.commandName === "erlc-information") {
        // Fix: guard against serverInfo not being loaded yet
        if (!serverInfo) {
            return interaction.reply({ content: "⏳ Server info is not available yet. Please try again in a moment.", ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setTitle(`${serverInfo.Name || "Private Server"} Information`)
            .setDescription(`Active Players: ${serverInfo.CurrentPlayers ?? "N/A"}`)
            .setColor("#3111e3")
            .setFooter({ text: "Liberty Tools Bot" })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
});

client.login(DISCORD_BOT_TOKEN);