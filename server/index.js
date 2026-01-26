import express from "express";

const app = express();
const port = process.env.PORT || 3000;
const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;

if (!token || !channelId) {
    console.warn("DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID is missing.");
}

const cors = (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    return next();
};

app.use(cors);

const parseRanking = (text) => {
    if (!text) return null;
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const items = [];
    let current = null;

    const matchRank = (line) => {
        const patterns = [
            /^#?\s*(1|2|3)\s*[.)：:]\s*(.+)$/i,
            /^([123])\s*位\s*[：:]\s*(.+)$/i,
            /^【\s*([123])\s*】\s*(.+)$/i
        ];
        for (const pattern of patterns) {
            const match = line.match(pattern);
            if (match) {
                return { rank: Number(match[1]), title: match[2] };
            }
        }
        return null;
    };

    for (const line of lines) {
        const hit = matchRank(line);
        if (hit) {
            current = { rank: hit.rank, title: hit.title, summary: "" };
            items.push(current);
        } else if (current && !current.summary) {
            current.summary = line;
        }
    }

    return items.length ? items : null;
};

const fetchRankingFromDiscord = async () => {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=15`;
    const res = await fetch(url, {
        headers: {
            Authorization: `Bot ${token}`
        }
    });

    if (!res.ok) {
        throw new Error(`Discord API error: ${res.status}`);
    }

    const messages = await res.json();
    for (const message of messages) {
        const content = message.content || "";
        const items = parseRanking(content);
        if (items) {
            return {
                items,
                sourceMessageId: message.id,
                sourceTimestamp: message.timestamp
            };
        }

        if (Array.isArray(message.embeds)) {
            for (const embed of message.embeds) {
                const embedText = [embed.title, embed.description]
                    .filter(Boolean)
                    .join("\n");
                const embedItems = parseRanking(embedText);
                if (embedItems) {
                    return {
                        items: embedItems,
                        sourceMessageId: message.id,
                        sourceTimestamp: message.timestamp
                    };
                }
            }
        }
    }
    return null;
};

app.get("/api/ranking", async (req, res) => {
    try {
        if (!token || !channelId) {
            return res.status(500).json({ error: "Missing DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID" });
        }
        const data = await fetchRankingFromDiscord();
        if (!data) {
            return res.status(404).json({ error: "Ranking not found" });
        }
        return res.json({
            items: data.items.slice(0, 3),
            sourceMessageId: data.sourceMessageId,
            sourceTimestamp: data.sourceTimestamp
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Failed to fetch ranking" });
    }
});

app.get("/health", (req, res) => {
    res.json({ ok: true });
});

app.listen(port, () => {
    console.log(`Ranking API running on port ${port}`);
});
