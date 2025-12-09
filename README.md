# project-slackbot
Slack bot for dev teams

## Slack app setup

### Create the Slack app
- **Create app**: Go to `https://api.slack.com/apps`, click **Create New App** → **From scratch**, and pick the workspace where you want the bot to run.
- **Basic settings**: Give the app a name (e.g. "Synergy") and save.

### Enable Socket Mode and tokens
- **Enable Socket Mode**: In the left nav, go to **Socket Mode** and turn it on.
- **Create App-Level Token**:
  - Click **Generate Token and Scopes**.
  - Name it (e.g. `synergy-app-token`) and add the scope: `connections:write`.
  - Copy the value (starts with `xapp-`) and set it as `SLACK_APP_TOKEN`.

### Bot token scopes (minimum for public channels)
In **OAuth & Permissions → Scopes → Bot Token Scopes**, add:
- **Reading & reacting**
  - `app_mentions:read` – receive `app_mention` events.
  - `channels:history` – read messages in public channels where the bot is a member.
  - `channels:read` – read channel metadata (names, ids).
  - `users:read` – look up user profiles for attribution.
- **Posting**
  - `chat:write` – send messages and replies.

If you want to index **private channels/DMs/MPIMs**, also add the relevant scopes, for example:
- `groups:read`, `groups:history` for private channels.
- `im:history`, `mpim:history` for DMs and multi-person DMs.

After adding scopes, click **Install to Workspace** (or **Reinstall**) and copy the **Bot User OAuth Token** (starts with `xoxb-`) as `SLACK_BOT_TOKEN`.

### Events to subscribe to
In **Event Subscriptions**:
- **Enable events**.
- Under **Subscribe to bot events**, add:
  - `message.channels` – to index messages in channels where the bot is present.
  - `app_mention` – to handle `@bot` questions and the `index channel` command.

Save your changes and reinstall the app if Slack prompts you.

### Environment variables
Set the following environment variables wherever you run the worker (locally or on Render):
- **Required**
  - `SLACK_BOT_TOKEN` – Bot User OAuth Token (`xoxb-...`).
  - `SLACK_APP_TOKEN` – App-Level Token (`xapp-...`, with `connections:write`).
  - `OPENAI_API_KEY` – for embeddings and chat completions.
  - `TURBOPUFFER_API_KEY` – for Turbopuffer vector storage.
- **Optional**
  - `TURBOPUFFER_NAMESPACE` – namespace name for Slack documents (defaults to `_hg_slack`).
  - `OPENAI_CHAT_MODEL` – chat model for answers (defaults to `gpt-5.1`).

Invite the bot to any channel you want indexed using `/invite @your-bot-name`.

## Deploying as a worker on Render

### 1. Prepare the repo
- **Ensure Node dependencies**: The project should have a `package.json` that includes `@slack/bolt` and any other dependencies this file needs.
- **Entry point**: Confirm that `app.js` is the file you want Render to run (update paths below if it lives in a subdirectory).

### 2. Create a Background Worker on Render
- **New background worker**: In Render, click **New** → **Background Worker** and connect the GitHub repo that contains this project.
- **Root Directory**: If this code lives in a subdirectory (e.g. `project-slackbot`), set **Root Directory** accordingly.
- **Build Command**: Something like:
  - `npm install`
  - or, if needed: `cd project-slackbot && npm install`
- **Start Command**: Run the Slack bot process:
  - `node app.js`
  - or, if in a subdirectory: `node project-slackbot/app.js`

Because this app uses **Socket Mode**, it does not need an HTTP port exposed; it just maintains a WebSocket connection to Slack.

### 3. Configure environment on Render
- In the worker’s **Environment** section, add the variables described above:
  - `SLACK_BOT_TOKEN`
  - `SLACK_APP_TOKEN`
  - `OPENAI_API_KEY`
  - `TURBOPUFFER_API_KEY`
  - (Optional) `TURBOPUFFER_NAMESPACE`
  - (Optional) `OPENAI_CHAT_MODEL`

Deploy the worker. Once the service is running and the app is installed in Slack, mention the bot (e.g. `@Synergy index channel`) in a channel it has been invited to and it will start indexing and answering questions.
