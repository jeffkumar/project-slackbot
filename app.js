const { App } = require("@slack/bolt");
require("dotenv").config({ path: "../.env.local" });

const app = new App({
  token: process.env.SLACK_BOT_TOKEN, // xoxb-...
  appToken: process.env.SLACK_APP_TOKEN, // xapp-...
  socketMode: true
});

// --- Turbopuffer + OpenAI helpers -------------------------------------------------

const openaiApiKey = process.env.OPENAI_API_KEY;
const turbopufferApiKey = process.env.TURBOPUFFER_API_KEY;
const turbopufferNamespace = process.env.TURBOPUFFER_NAMESPACE || "_hg_slack";

function toSlackMarkdown(text) {
  if (typeof text !== "string") {
    return "";
  }
  // Convert **bold** (GitHub-style) to *bold* (Slack mrkdwn)
  // and normalize leading "- " list items into real bullets.
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^\s*-\s+/gm, "• ");
}

async function createEmbedding(input) {
  if (!openaiApiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Embedding request failed: ${message}`);
  }

  const json = await response.json();
  const first = json.data && json.data[0];
  if (!first || !Array.isArray(first.embedding)) {
    throw new Error("Invalid embeddings response");
  }
  return first.embedding;
}

async function upsertToTurbopuffer(rows) {
  if (!turbopufferApiKey) {
    throw new Error("Missing TURBOPUFFER_API_KEY");
  }
  if (!turbopufferNamespace) {
    throw new Error("Missing TURBOPUFFER_NAMESPACE");
  }

  const response = await fetch(
    `https://api.turbopuffer.com/v2/namespaces/${turbopufferNamespace}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${turbopufferApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        upsert_rows: rows,
        distance_metric: "cosine_distance"
      })
    }
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Turbopuffer upsert failed: ${message}`);
  }
}

const MAX_CONTENT_CHARS = 3800;
const MAX_CHUNK_CHARS = 1800;

function buildSlackDocument({
  text,
  userId,
  userName,
  userEmail,
  channelId,
  channelName,
  ts,
  team
}) {
  const raw = (text || "").trim();
  if (!raw) {
    return null;
  }

  // Turbopuffer currently limits filterable attribute values to 4096 bytes.
  // Slack messages can be long, so we truncate the stored content to stay
  // under this limit while still keeping the most relevant text.
  const MAX_CONTENT_CHARS = 3800;
  const trimmed =
    raw.length > MAX_CONTENT_CHARS ? `${raw.slice(0, MAX_CONTENT_CHARS)}…` : raw;

  const id = `slack:${channelId}:${ts}`;
  const messageUrl = `https://slack.com/archives/${channelId}/p${String(
    ts
  ).replace(".", "")}`;

  const embeddingTextParts = [];
  if (userName) embeddingTextParts.push(`From ${userName}`);
  if (channelName) embeddingTextParts.push(`in #${channelName}`);
  const prefix =
    embeddingTextParts.length > 0
      ? `${embeddingTextParts.join(" ")}: `
      : "";

  return {
    id,
    content: trimmed,
    // Include user and channel names in the embedding text so questions
    // like "what about Nate?" can match messages authored by Nate even if
    // his name isn't in the message body itself.
    embeddingText: `${prefix}${raw}`,
    source: "slack",
    channel_id: channelId,
    channel_name: channelName,
    user_id: userId,
    user_name: userName,
    user_email: userEmail,
    team_id: team,
    ts,
    url: messageUrl
  };
}

function chunkText(text) {
  const chunks = [];
  let startIndex = 0;

  while (startIndex < text.length) {
    const endIndex = Math.min(startIndex + MAX_CHUNK_CHARS, text.length);
    chunks.push(text.slice(startIndex, endIndex));
    startIndex = endIndex;
  }

  return chunks;
}

async function indexSlackMessage(document) {
  if (!document) {
    return;
  }

  const embeddingInput =
    typeof document.embeddingText === "string"
      ? document.embeddingText
      : document.content;
  const chunks = chunkText(embeddingInput);

  // Don't send embeddingText itself to Turbopuffer, it's only for local use.
  const {
    embeddingText,
    content: _originalContent,
    id: baseId,
    ...attributes
  } = document;

  const rowPromises = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const rowId = chunks.length === 1 ? baseId : `${baseId}:chunk:${index}`;

    rowPromises.push(
      createEmbedding(chunk).then((vector) => ({
        id: rowId,
        vector,
        content:
          chunk.length > MAX_CONTENT_CHARS
            ? `${chunk.slice(0, MAX_CONTENT_CHARS)}…`
            : chunk,
        parent_id: baseId,
        chunk_index: index,
        ...attributes
      }))
    );
  }

  const rows = await Promise.all(rowPromises);
  await upsertToTurbopuffer(rows);
  console.log("📥 Indexed Slack message in Turbopuffer", {
    id: baseId,
    chunks: rows.length,
    channel: document.channel_name,
    user: document.user_name
  });
}

async function fetchAllChannelMessages(client, channelId) {
  const allMessages = [];
  let cursor;

  do {
    const response = await client.conversations.history({
      channel: channelId,
      limit: 200,
      cursor
    });

    const messages = response.messages || [];
    for (const message of messages) {
      if (!message.subtype && message.text) {
        allMessages.push(message);
      }
    }

    cursor =
      response.response_metadata &&
        response.response_metadata.next_cursor
        ? response.response_metadata.next_cursor
        : undefined;
  } while (cursor);

  return allMessages;
}

const chatModel = process.env.OPENAI_CHAT_MODEL || "gpt-5.1";

async function queryTurbopuffer(query, topK = 20) {
  if (!turbopufferApiKey) {
    throw new Error("Missing TURBOPUFFER_API_KEY");
  }
  if (!turbopufferNamespace) {
    throw new Error("Missing TURBOPUFFER_NAMESPACE");
  }

  const vector = await createEmbedding(query);

  const response = await fetch(
    `https://api.turbopuffer.com/v2/namespaces/${turbopufferNamespace}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${turbopufferApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        rank_by: ["vector", "ANN", vector],
        top_k: topK,
        include_attributes: true
      })
    }
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Turbopuffer query failed: ${message}`);
  }

  const json = await response.json();
  if (!json.rows || !Array.isArray(json.rows)) {
    return [];
  }
  return json.rows;
}

function formatRetrievedContext(rows) {
  if (!rows.length) {
    return "";
  }

  const formatted = rows
    .map((row, index) => {
      const contentValue = row.content || "";
      const content = String(contentValue);
      const truncated =
        content.length > 1000 ? `${content.slice(0, 1000)}…` : content;

      const channelName =
        typeof row.channel_name === "string" ? row.channel_name : "";
      const userName = typeof row.user_name === "string" ? row.user_name : "";
      const ts = typeof row.ts === "string" ? row.ts : "";

      const headerParts = [];
      if (channelName) headerParts.push(`#${channelName}`);
      if (userName) headerParts.push(userName);
      if (ts) headerParts.push(`ts=${ts}`);
      const header =
        headerParts.length > 0
          ? headerParts.join(" · ")
          : `result ${String(index + 1)}`;

      return `${header}\n${truncated}`;
    })
    .join("\n\n");

  return formatted;
}

async function answerWithRag(question) {
  if (!openaiApiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const rows = await queryTurbopuffer(question);
  const context = formatRetrievedContext(rows);

  console.log("🔎 RAG query results:", {
    question,
    rowCount: rows.length
  });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: chatModel,
      messages: [
        {
          role: "system",
          content:
            "You are Jeff and Huy's Project Hog, a helpful assistant answering questions based on Slack channel history. Use the provided Slack message context when it is relevant. If the context does not contain the answer, say so briefly and answer from general knowledge when appropriate."
        },
        {
          role: "system",
          content: context
            ? `Here is retrieved Slack context:\n\n${context}`
            : "No relevant Slack messages were retrieved for this question."
        },
        {
          role: "user",
          content: question
        }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Chat completion failed: ${message}`);
  }

  const json = await response.json();
  const choice =
    json.choices && json.choices.length > 0 ? json.choices[0] : undefined;
  if (!choice || !choice.message || !choice.message.content) {
    throw new Error("Invalid chat completion response");
  }

  return choice.message.content;
}

// --- Live ingestion for every new message ----------------------------------------

// Listen to any new message in channels where the bot is a member
app.message(async ({ message, client, context }) => {
  if (!message.subtype) {
    const botUserId = context.botUserId;
    const textValue = typeof message.text === "string" ? message.text : "";
    const isDirectBotMention =
      typeof botUserId === "string" &&
      textValue.includes(`<@${botUserId}>`);

    // Don't index direct questions/commands to Synergy itself.
    if (isDirectBotMention) {
      console.log("🤖 Skipping indexing for direct bot mention message.");
      return;
    }

    try {
      const [userResult, channelResult] = await Promise.all([
        client.users.info({ user: message.user }),
        client.conversations.info({ channel: message.channel })
      ]);

      const profile = userResult.user.profile;
      const displayName = profile.display_name || profile.real_name || "Unknown";

      console.log("💬 Channel message:", {
        text: message.text,
        userId: message.user,
        userName: displayName,
        userEmail: profile.email,
        channelId: message.channel,
        channelName: channelResult.channel && channelResult.channel.name,
        ts: message.ts
      });

      const document = buildSlackDocument({
        text: message.text,
        userId: message.user,
        userName: displayName,
        userEmail: profile.email,
        channelId: message.channel,
        channelName: channelResult.channel && channelResult.channel.name,
        ts: message.ts,
        team: message.team
      });

      await indexSlackMessage(document);
    } catch (error) {
      console.error("Failed to enrich/index message", error);

      console.log("💬 Channel message (raw):", {
        text: message.text,
        user: message.user,
        channel: message.channel,
        ts: message.ts
      });
    }
  }
});

// --- Commands via mentions -------------------------------------------------------

// Listen to mentions of the bot (e.g. "@Synergy index channel")
app.event("app_mention", async ({ event, client, say }) => {
  if (!event.subtype) {
    const normalized = (event.text || "").toLowerCase();

    // "index channel" command
    if (normalized.includes("index channel")) {
      await say("📚 Indexing this channel into Synergy's project database. This may take a moment...");

      try {
        const [channelInfo, messages] = await Promise.all([
          client.conversations.info({ channel: event.channel }),
          fetchAllChannelMessages(client, event.channel)
        ]);

        const uniqueUserIds = Array.from(
          new Set(
            messages
              .map((m) => m.user)
              .filter((userId) => typeof userId === "string")
          )
        );

        const userProfiles = {};
        await Promise.all(
          uniqueUserIds.map(async (userId) => {
            try {
              const result = await client.users.info({ user: userId });
              userProfiles[userId] = result.user.profile;
            } catch (error) {
              console.error("Failed to fetch user profile during indexing", {
                userId,
                error
              });
            }
          })
        );

        for (const message of messages) {
          const profile = userProfiles[message.user] || {};
          const displayName =
            profile.display_name || profile.real_name || "Unknown";

          const document = buildSlackDocument({
            text: message.text,
            userId: message.user,
            userName: displayName,
            userEmail: profile.email,
            channelId: event.channel,
            channelName:
              channelInfo.channel && channelInfo.channel.name
                ? channelInfo.channel.name
                : undefined,
            ts: message.ts,
            team: message.team
          });

          // Sequential to keep things simple and idempotent (same id upserts).
          // eslint-disable-next-line no-await-in-loop
          await indexSlackMessage(document);
        }

        await say("✅ Finished indexing this channel into Synergy.");
      } catch (error) {
        console.error("Failed to index channel history", error);
        await say("❌ Sorry, I ran into a problem while indexing this channel.");
      }

      return;
    }

    // Default behavior for other mentions: answer using RAG over indexed Slack.
    const question = (event.text || "").replace(/<@[^>]+>/g, "").trim();

    console.log("💬 New mention (question):", {
      rawText: event.text,
      cleanedQuestion: question || "(empty)",
      user: event.user,
      channel: event.channel,
      ts: event.ts
    });

    const effectiveQuestion =
      question || "Summarize the most relevant context for this channel.";

    await say({
      text: "🤔 Let me check what I know about this...",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "🤔 Let me check what I know about this..."
          }
        }
      ]
    });

    try {
      const answer = await answerWithRag(effectiveQuestion);
      await say({
        text: toSlackMarkdown(answer),
        mrkdwn: true
      });
    } catch (error) {
      console.error("Failed to answer question with RAG", error);
      await say({
        text:
          "❌ Sorry, I ran into a problem while answering that. Please try again in a moment.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                "❌ Sorry, I ran into a problem while answering that. Please try again in a moment."
            }
          }
        ]
      });
    }
  }
});

// Start the app
(async () => {
  await app.start();
  console.log("⚡️ Bolt app with Socket Mode is running!");
})();