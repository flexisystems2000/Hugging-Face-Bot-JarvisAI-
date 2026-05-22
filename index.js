const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    DisconnectReason,
    downloadContentFromMessage
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');

require('dotenv').config();
const quizEngine = require('./quizEngine');
const grammarWatchdog = require('./grammarWatchdog');
const paymentHandler = require('./paymentHandler');

const app = express();
// Hugging Face strictly overrides process.env.PORT to 7860
const port = process.env.PORT || 7860; 

// Initialize parser systems globally at the absolute top
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- SYSTEM GUARDS ---
process.on('uncaughtException', (err) => console.log('⚠️ System Error:', err.message));
process.on('unhandledRejection', (err) => console.log('⚠️ Rejection Guard:', err.message));

// --- CONFIG ---
const OWNER_NUMBER = "2347051768946"; 
const BOT_NAME = "JARVIS AI";
const POWERED_BY = "Flexi Digital Academy";
const MONGO_URI = "mongodb+srv://JarvisAI:flexisystems2000@cluster0.7g5odvt.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

const firebaseConfig = {
  apiKey: "AIzaSyCoGX2bXlvuwcJY8oyW6_J42fgxfH5vZao",
  authDomain: "jarvisai-1a594.firebaseapp.com",
  projectId: "jarvisai-1a594",
  storageBucket: "jarvisai-1a594.firebasestorage.app",
  messagingSenderId: "868499596875",
  appId: "1:868499596875:web:4bf592934f6086be8a4fce"
};

// --- DATABASE ---
const WarnSchema = new mongoose.Schema({
    userId: String,
    count: { type: Number, default: 0 }
});

const ConfigSchema = new mongoose.Schema({
    keyName: String,
    keyValue: String
});

const Warn = mongoose.model('Warn', WarnSchema);
const Config = mongoose.model('Config', ConfigSchema);

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.log("❌ DB Error:", err.message));


// --- AI FUNCTION ---
async function askAI(prompt, base64Media = null, isPDF = false) {
    try {
        const endpoint = isPDF ? 'pdf' : 'ai';
        const payload = {
            prompt,
            ...(isPDF ? { fileBase64: base64Media } : { image: base64Media })
        };
        const res = await axios.post(
            `https://flexieduconsult-ai-link.onrender.com/${endpoint}`,
            payload
        );
        return res.data?.result || "🤖 No response from AI";
    } catch (err) {
        console.log("AI LINK ERROR:", err.message);
        return "⚠️ AI service unavailable.";
    }
}

// --- GLOBAL STATE ---
const groupCache = new Map();
const activityTracker = new Map();
let protocolFired = false;

setInterval(() => {
    const hour = new Date().toLocaleString("en-US", {
        timeZone: "Africa/Lagos",
        hour: "2-digit",
        hour12: false
    });
    if (hour === "00") {
        protocolFired = false;
        console.log("🔄 Protocol reset (Nigeria Midnight)");
    }
}, 60000);

// --- MEDIA DOWNLOADER ---
async function downloadMedia(message) {
    const type = Object.keys(message)[0];
    const stream = await downloadContentFromMessage(
        message[type],
        type.replace('Message', '')
    );
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
}

let sock;

// --- BOT START ---
async function startJARVIS() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "125.0.0"],
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect =
                (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startJARVIS();
        } else if (connection === 'open') {
            console.log(`✅ ${BOT_NAME} Online & Synced`);
        }
    });

    // --- GROUP WELCOME / GOODBYE ---
    sock.ev.on('group-participants.update', async (anu) => {
        const jid = anu.id;
        if (!jid) return;
        await new Promise(r => setTimeout(r, 1500));
        try {
            let metadata = groupCache.get(jid);
            if (!metadata) {
                metadata = await sock.groupMetadata(jid).catch(() => ({ subject: "this group" }));
            }
            const groupName = metadata.subject;

            for (const num of anu.participants) {
                if (num === sock.user.id.split(':')[0] + '@s.whatsapp.net') continue;
                const userTag = num.split('@')[0];

                if (anu.action === 'add') {
                    await sock.sendMessage(jid, {
                        text: `👋 @${userTag}\n\n🤖 *Welcome to ${groupName}*\n\nSuccess in your Post-UTME starts here.\n\n_Powered by ${POWERED_BY}_ 🚀`,
                        mentions: [num]
                    });
                } else if (anu.action === 'remove') {
                    await sock.sendMessage(jid, {
                        text: `👋 Goodbye @${userTag}\n\nWe wish you success ahead from *${groupName}* 🎓`,
                        mentions: [num]
                    });
                }
            }
        } catch (err) {
            console.log("Automation Error:", err.message);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const jid = m.key.remoteJid;
        const sender = m.key.participant || m.key.remoteJid;

        activityTracker.set(sender, Date.now());

        // ANTI STATUS MENTION SYSTEM
        try {
            const type = m.messageStubType || m.message?.messageStubType;
            const isStatusMention = type === 'group_mention_notification' || type === 156 || type === 0x9c;

            if (isStatusMention) {
                const participant = m.messageStubParameters?.[0];
                const groupJid = jid;
                if (!participant) return;

                await sock.sendMessage(groupJid, { delete: m.key }).catch(() => {});

                if (!global.db) global.db = { data: { users: {} } };
                if (!global.db.data.users[participant]) {
                    global.db.data.users[participant] = { warn: 0 };
                }

                global.db.data.users[participant].warn += 1;
                const warnCount = global.db.data.users[participant].warn;
                const maxWarns = 3;

                const msg = `*⚠️ JARVIS AI SAFETY SYSTEM ⚠️*\n\n@${participant.split('@')[0]}, tagging this group in status is not allowed.\n\n*Strike:* ${warnCount}/${maxWarns}`;
                await sock.sendMessage(groupJid, { text: msg, mentions: [participant] });

                if (warnCount >= maxWarns) {
                    await sock.sendMessage(groupJid, { text: `🚫 Final strike reached. Removing user...` });
                    await sock.groupParticipantsUpdate(groupJid, [participant], "remove");
                }
                return;
            }
        } catch (err) {
            console.log("Anti-status error:", err.message);
        }

        const body = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || "";
        const text = body.toLowerCase().trim();
        const isOwner = sender.includes(OWNER_NUMBER);

        const wasQuizMessage = await quizEngine.handleLiveMarking(sock, jid, sender, body, m);
        if (wasQuizMessage) return;
            
        if (text.includes("jarvis") && !text.startsWith("!")) {
            await sock.sendMessage(jid, { react: { key: m.key, text: "🤖" } });
        }

        if (!m.key.fromMe && body) {
            const correctedVersion = await grammarWatchdog.autoCorrectGrammar(body);
            if (correctedVersion && correctedVersion.trim().toLowerCase() !== body.trim().toLowerCase()) {
                const userTag = sender.split('@')[0];
                const alertPayload = `📝 *Grammar Check Alert* 📝\n\n@${userTag}, I noticed a minor slip in your structure. Here is the corrected version:\n\n👉 *"${correctedVersion}"*`;
                await sock.sendMessage(jid, { text: alertPayload, mentions: [sender] }, { quoted: m });
            }
        }

        let metadata;
        let isStaff = isOwner;

        if (jid.endsWith('@g.us')) {
            try {
                metadata = groupCache.get(jid);
                if (!metadata || Date.now() - (metadata.lastFetch || 0) > 300000) {
                    metadata = await sock.groupMetadata(jid);
                    metadata.lastFetch = Date.now();
                    groupCache.set(jid, metadata);
                }
                const admins = (metadata.participants || []).filter(p => p.admin).map(p => p.id);
                isStaff = isOwner || admins.includes(sender);
            } catch (err) {
                isStaff = isOwner;
            }
        }

        if (jid.endsWith('@g.us') && !isStaff) {
            const badWords = ["rubbish", "mumu", "foolish", "stupid", "bastard", "ode"];
            const isLink = text.includes("http") || text.includes(".com") || text.includes("chat.whatsapp");
            const isBadWord = badWords.some(word => text.includes(word));

            if (isLink || isBadWord) {
                await sock.sendMessage(jid, { delete: m.key }).catch(() => {});
                let userWarn = await Warn.findOneAndUpdate({ userId: sender }, { $inc: { count: 1 } }, { upsert: true, new: true });

                if (userWarn.count >= 3) {
                    await sock.sendMessage(jid, { text: `🚫 @${sender.split('@')[0]} removed (3 Strikes).`, mentions: [sender] });
                    await sock.groupParticipantsUpdate(jid, [sender], "remove");
                    await Warn.deleteOne({ userId: sender });
                } else {
                    await sock.sendMessage(jid, { text: `⚠️ *Watchdog*\n@${sender.split('@')[0]}, violation detected (${userWarn.count}/3).`, mentions: [sender] });
                }
                return;
            }
        }

        const command = text.split(/ +/)[0];
        const args = body.trim().split(/ +/).slice(1);

        if (jid.endsWith('@g.us') && (text.startsWith("!ai") || text.includes("jarvis"))) {
            const isDoc = !!m.message.documentMessage;
            const isImg = !!m.message.imageMessage || !!m.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

            if (isDoc || isImg) {
                await sock.sendMessage(jid, { react: { key: m.key, text: "📂" } });
                await sock.sendPresenceUpdate('composing', jid);
                try {
                    let mediaMessage = isDoc ? m.message.documentMessage : (m.message.imageMessage ? m.message : m.message.extendedTextMessage?.contextInfo?.quotedMessage);
                    const buffer = await downloadMedia(mediaMessage);
                    const base64Media = buffer.toString('base64');
                    const fileName = isDoc ? m.message.documentMessage.fileName : "Image Analysis";

                    const aiReply = await askAI(body || `Please analyze this file: ${fileName}`, base64Media);
                    return sock.sendMessage(jid, { text: `🎓 *GROUP STUDY ASSISTANT*\n\n${aiReply}` }, { quoted: m });
                } catch (err) {
                    console.log("File Error:", err.message);
                    return sock.sendMessage(jid, { text: "⚠️ I couldn't read that file. Ensure it's a PDF or Image." });
                }
            }
        }

        if (text.includes("create file") || text.includes("generate pdf") || text.includes("write note")) {
            await sock.sendMessage(jid, { react: { key: m.key, text: "📝" } });
            await sock.sendPresenceUpdate('composing', jid);

            const contentPrompt = `Create a detailed, professional study document based on this request: ${text}. Format it clearly for students.`;
            const content = await askAI(contentPrompt);
            const fileBuffer = Buffer.from(content, 'utf-8');
            const cleanName = text.split("file")[1]?.trim()?.replace(/ /g, "_") || "JARVIS_Study_Note";

            return sock.sendMessage(jid, {
                document: fileBuffer,
                mimetype: 'text/plain',
                fileName: `${cleanName}.txt`,
                caption: `✅ *JARVIS Document Generator*\n\nStudy notes generated successfully.`
            }, { quoted: m });
        }

        const nigeriaTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: 'numeric', hour12: false }).format(new Date());
        const currentHourWAT = parseInt(nigeriaTime);

        if (isStaff && !isNaN(currentHourWAT)) {
            if (currentHourWAT >= 19 && !protocolFired && !text.startsWith("!")) {
                const subjects = ["math", "physics", "chemistry", "biology", "english", "economics", "government"];
                const foundSubject = subjects.find(s => text.includes(s));
                if (foundSubject) {
                    const adminTag = `@${sender.split('@')[0]}`;
                    await sock.sendMessage(jid, {
                        text: `================\n*askAI PROTOCOL ONLINE*\n================\n${adminTag} Kindly use !ai to fetch PostUTME questions for ${foundSubject.toUpperCase()}`,
                        mentions: [sender]
                    });
                    protocolFired = true;
                }
            }
        }

        if (command === "!timetable") {
            try {
                const timetableUrl = 'https://i.postimg.cc/vTyBtTzS/IMG-20260511-WA0031.jpg';
                const response = await axios.get(timetableUrl, { responseType: 'arraybuffer' });
                await sock.sendMessage(jid, {
                    image: Buffer.from(response.data),
                    caption: `🗓️ *POST UTME TUTORIALS 2025/2026*\n\n✅ *Starts:* 11th July\n💰 *Fee:* ₦6,000 monthly\n\n📢 Join WhatsApp group:\nhttps://chat.whatsapp.com/KoI4QtlwggOFtGyoE0MYY4\n\n_Powered by ${POWERED_BY}_`
                });
            } catch (err) {
                console.log("Timetable Error:", err.message);
                await sock.sendMessage(jid, { text: "❌ Failed to load timetable image." });
            }
        }

        if (command === "!listadmins") {
            if (!jid.endsWith('@g.us')) return sock.sendMessage(jid, { text: "❌ This command only works in groups." });
            try {
                let metadata = groupCache.get(jid);
                if (!metadata || Date.now() - (metadata.lastFetch || 0) > 300000) {
                    metadata = await sock.groupMetadata(jid);
                    metadata.lastFetch = Date.now();
                    groupCache.set(jid, metadata);
                }
                const admins = metadata.participants.filter(p => p.admin);
                let adminList = `👑 *${metadata.subject} Admins*\n\n`;
                admins.forEach((admin, index) => { adminList += `${index + 1}. @${admin.id.split('@')[0]}\n`; });
                adminList += `\n🤖 _Powered by ${POWERED_BY}_`;
                await sock.sendMessage(jid, { text: adminList, mentions: admins.map(a => a.id) });
            } catch (err) {
                console.log("ListAdmins Error:", err.message);
                await sock.sendMessage(jid, { text: "❌ Failed to fetch admin list." });
            }
        }

        if (command === "!menu" || command === "!help") {
            const menuText = `🤖 *${BOT_NAME} SYSTEM MENU*\n\n*Powered by ${POWERED_BY}*\n\n━━━━━━━━━━━━━━━━━━━━\n✨ *AI & UTILITY*\n🔹 *!ai [query]* - Ask anything\n🔹 *!ginfo* - Group status report\n🔹 *!listonline* - Activity tracker\n🔹 *!timetable* - Get latest tutorial schedule\n🔹 *!listadmins* - View group admins\n🔹 *!image* - To generate images\n\n🛡️ *GROUP MODERATION*\n🔸 *!add [number]* - Add new member\n🔸 *!kick @user* - Remove member\n🔸 *!promote @user* - Make admin\n🔸 *!mute [time] [unit]* - Lock group\n🔸 *!unmute [time] [unit]* - Open group\n🔸 *!reset @user* - Clear warnings\n\n🚫 *SYSTEM PROTECTIONS*\n✅ *Watchdog:* Anti-Link & Anti-Badword\n✅ *Anti-Status:* Deletes status tags\n✅ *Auto-Greet:* Welcome/Goodbye\n━━━━━━━━━━━━━━━━━━━━\n\n_Type !mute 30 min to test the timer!_`;
            return sock.sendMessage(jid, { text: menuText, quoted: m });
        }

        if (command === "!pay") {
            await paymentHandler.handlePaymentRequest(sock, m, sender, args);
            return;
        }

        // --- PROFILE CONFIG (FIRESTORE) ---
        const admin = require("firebase-admin");
        if (!admin.apps.length) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            console.log("✅ Firebase Connected");
        }
        const db = admin.firestore();

        function normalizePhone(input = "") {
            return input.toString().replace(/\D/g, '').replace(/^0/, '234');
        }

        if (body.startsWith("!name ")) {
            try {
                const suppliedName = body.replace("!name ", "").trim();
                if (!suppliedName || suppliedName.length < 2) {
                    await sock.sendMessage(sender, { text: `⚠️ INVALID NAME\n\nPlease enter a valid name.\n\nExample:\n!name FLEXI SYSTEMS` });
                    return;
                }
                const phone = normalizePhone(sender);
                await db.collection("users").doc(phone).set({
                    name: suppliedName,
                    phone: phone,
                    updatedAt: Date.now(),
                    createdAt: Date.now()
                }, { merge: true });

                await sock.sendMessage(sender, {
                    text: `✅ PROFILE REGISTERED SUCCESSFULLY 🎓\n\nThank you, your name has been saved as:\n\n${suppliedName.toUpperCase()}\n\n🚀 You can now proceed to type:\n\n!pay month\nor\n!pay week\n\nto receive your secure billing invoice!`
                });
            } catch (error) {
                console.log("❌ Name registration ERROR:", error);
                await sock.sendMessage(sender, { text: `❌ PROFILE REGISTRATION FAILED\n\nAn unexpected error occurred while saving your profile.` });
            }
        }       

        if (isStaff && command === "!ai") {
            const prompt = args.join(" ");
            const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const isQuotedImage = quoted?.imageMessage;
            const isDirectImage = m.message.imageMessage;

            if (!prompt && !isDirectImage && !isQuotedImage) {
                return sock.sendMessage(jid, { text: "Oya, what is your question? You can also send an image." });
            }

            await sock.sendPresenceUpdate('composing', jid);
            let base64Image = null;

            if (isDirectImage || isQuotedImage) {
                await sock.sendMessage(jid, { react: { key: m.key, text: "📸" } });
                const mediaMessage = isDirectImage ? m.message : quoted;
                try {
                    const buffer = await downloadMedia(mediaMessage);
                    base64Image = buffer.toString('base64');
                } catch (err) { console.log("Media Error:", err.message); }
            }

            const aiReply = await askAI(prompt || "Analyze this image clearly.", base64Image);
                    
