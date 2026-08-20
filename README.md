<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

# QQ Bot Channel Plugin for OpenClaw

**Forked version with enhanced features for group/C2C differential handling and message coalescing**

**Connect your AI assistant to QQ — private chat, group chat, and rich media, all in one plugin.**

### 🚀 Current Version: `v2.1.0`

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Platform](https://img.shields.io/badge/platform-OpenClaw-orange)](https://github.com/jerryliang122/openclaw-qqbot)
[![Node.js](https://img.shields.io/badge/Node.js->=18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fork](https://img.shields.io/badge/fork-enhanced-9cf)](https://github.com/jerryliang122/openclaw-qqbot)

<br/>

**[简体中文](README.zh.md) | English**

> **Note**: This is a **forked version** with custom enhancements. For the official version, see [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot).
>
> **Not published to npm** — install directly from GitHub or local source.

Scan to join the QQ group chat

<img width="400" alt="QQ QR Code" src="./docs/images/developer-group.png" />

</div>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔄 **Differential Handling** | Group: message coalescing (all messages processed, fast messages merged); C2C: user can interrupt (new message cancels old) |
| 🔒 **Multi-Scene** | C2C private chat, group chat (@mention / autonomous dual mode) |
| 👥 **Group Fine-Tuning** | Per-group @trigger rules, tool policies, custom prompts, message filtering, coalescing config |
| 🌐 **Dual Transport** | WebSocket (default) or Webhook (HTTP callback) — switch via config |
| 🖼️ **Rich Media** | Send & receive images, voice, video, and files |
| 🎙️ **Voice (STT/TTS)** | Speech-to-text transcription & text-to-speech replies |
| 🔥 **One-Click Hot Upgrade** | Send `/bot-upgrade` in private chat to upgrade — no server login needed |
| ⏰ **Scheduled Push** | Proactive message delivery via scheduled tasks |
| 🔗 **URL Support** | Direct URL sending in private chat (no restrictions) |
| ⌨️ **Typing Indicator** | "Bot is typing..." status shown in real-time |
| 📝 **Markdown** | Full Markdown formatting support |
| 🛠️ **Commands** | Native OpenClaw command integration |
| 💬 **Quoted Context** | Parses the original message a user is replying to and injects it into AI context, so the model always knows exactly which message is being referenced |
| 📦 **Large File Support** | Auto chunked upload for large files (parallel upload with retry), up to 100 MB |
| 🔐 **Command Execution Approval** | AI requests approval via Inline Keyboard buttons before executing commands — tap to allow or deny |

---

## 📸 Feature Showcase

> **Note:** This plugin serves as a **message channel** only — it relays messages between QQ and OpenClaw. Capabilities like image understanding, voice transcription, drawing, etc. depend on the **AI model** you configure and the **skills** installed in OpenClaw, not on this plugin itself.

### 💬 Quoted Message Context

When a user quotes a message in QQ, the plugin automatically parses the quoted message content and injects it into the AI context, so the model clearly knows "which message the user is replying to" and gives more accurate responses. Supports text and media messages (image/voice/video/file), and works across devices.

<img width="360" src="docs/images/ref-msg.png" alt="Quoted Message Context Demo" />

### 🎙️ Voice Messages (STT)

With STT configured, the plugin automatically transcribes voice messages to text before passing them to AI. The whole process is transparent to the user — sending voice feels as natural as sending text.

> **You**: *(send a voice message)* "What's the weather like tomorrow in Shenzhen?"
>
> **QQBot**: Tomorrow (March 7, Saturday) Shenzhen weather forecast 🌤️ ...

<img width="360" src="docs/images/voice-stt.jpg" alt="Voice STT Demo" />

### 📄 File Understanding

Send any file to the bot — novels, reports, spreadsheets — AI automatically recognizes the content and gives an intelligent reply.

> **You**: *(send a TXT file of "War and Peace")*
>
> **QQBot**: Got it! You uploaded the Chinese version of "War and Peace" by Leo Tolstoy. This appears to be the opening of Chapter 1...

<img width="360" src="docs/images/file-understand.jpg" alt="File Understanding Demo" />

### 🖼️ Image Understanding

If your main model supports vision (e.g. Tencent Hunyuan `hunyuan-vision`), AI can understand images too. This is a general multimodal capability, not plugin-specific.

> **You**: *(send an image)*
>
> **QQBot**: Haha, so cute! Is that a QQ penguin in a lobster costume? 🦞🐧 ...

<img width="360" src="docs/images/image-understand.jpg" alt="Image Understanding Demo" />

### 🎨 Image Sending

> **You**: Draw me a cat
>
> **QQBot**: Here you go! 🐱

AI can send images directly. Supports local paths and URLs. Formats: jpg/png/gif/webp/bmp.

<img width="360" src="docs/images/image-send.jpg" alt="Image Generation Demo" />

### 🔊 Voice Sending

> **You**: Tell me a joke in voice
>
> **QQBot**: *(sends a voice message)*

AI can send voice messages directly. Formats: mp3/wav/silk/ogg. No ffmpeg required.

<img width="360" src="docs/images/voice-send.jpg" alt="TTS Voice Demo" />

### ⏰ Scheduled Reminder (Proactive Message)

> **You**: Remind me to eat in 5 minutes
>
> **QQBot**: confirms the reminder first, then proactively sends a voice + text reminder when time is up

This capability depends on OpenClaw cron scheduling and proactive messaging. If no reminder arrives, a common reason is QQ-side interception of bot proactive messages.

<img width="360" src="docs/images/reminder.jpg" alt="Scheduled Reminder Demo" />

### 📎 File Sending

> **You**: Extract chapter 1 of War and Peace and send it as a file
>
> **QQBot**: *(sends a .txt file)*

AI can send files directly, in any format.

<img width="360" src="docs/images/file-send.jpg" alt="File Sending Demo" />

Since v1.6.6, large file transfer is supported: images up to 20MB, videos up to 30MB, attachments up to 100MB, with a daily transfer limit of 2GB.

<img width="360" src="docs/images/large-file-transfer.jpg" alt="Large File Transfer Demo" />

### 🔐 Command Execution Approval

When the AI needs to execute a command, the plugin sends an approval request via QQ message with interactive buttons — tap **✅ Allow Once**, **⭐ Always Allow**, or **❌ Deny** to control whether the command runs. 

Use the `/bot-approve` command to manage the approval mode (allowlist / off / strict).

<img width="360" src="docs/images/approve.png" alt="Command Execution Approval Demo" />

### 🎬 Video Sending

> **You**: Send me a demo video
>
> **QQBot**: *(sends a video)*

AI can send videos directly. Supports local files and URLs.

<img width="360" src="docs/images/video-send.jpg" alt="Video Sending Demo" />

> **Under the hood:** Upload dedup caching, ordered queue delivery, and multi-layer audio format fallback.

### 🛠️ Slash Commands

The plugin provides built-in slash commands that are intercepted before reaching the AI queue, giving instant responses for diagnostics and management.

#### `/bot-ping` — Latency Test

> **You**: `/bot-ping`
>
> **QQBot**: ✅ pong！⏱ Latency: 602ms (network: 602ms, plugin: 0ms)

Measures end-to-end latency from QQ server push to plugin response, broken down into network transport and plugin processing time.

<img width="360" src="docs/images/slash-ping.jpg" alt="Ping Demo" />

#### `/bot-version` — Version Info

> **You**: `/bot-version`
>
> **QQBot**: 🦞 Framework: OpenClaw 2026.3.13 (61d171a) / 🤖 Plugin: v2.1.0 / 🌟 GitHub repo

Shows framework version, plugin version, and a direct link to the official repository.

<img width="360" src="docs/images/slash-version.jpg" alt="Version Demo" />

#### `/bot-help` — Command List

> **You**: `/bot-help`
>
> **QQBot**: Lists all available slash commands with clickable shortcuts.

<img width="360" src="docs/images/slash-help.jpg" alt="Help Demo" />

#### `/bot-upgrade` — One-Click Hot Upgrade

> **You**: `/bot-upgrade`
>
> **QQBot**: 📌 Current: v2.0.0 / ✅ New version v2.1.0 available / Click button below to confirm

Credentials are automatically backed up before upgrade. Version existence is verified against npm before proceeding. Auto-recovery on failure.

> ⚠️ Hot upgrade is currently not supported on Windows. Sending `/bot-upgrade` on Windows will return a manual upgrade guide instead.

> **Note**: For this forked version, `/bot-upgrade` will upgrade from the GitHub repository. Make sure you have git access.

<img width="360" src="docs/images/hot-update.jpg" alt="Hot Upgrade Demo" />

#### `/bot-logs` — Log Export

> **You**: `/bot-logs`
>
> **QQBot**: 📋 Logs packaged (~2000 lines), sending file... *(sends a .txt file)*

Exports the last ~2000 lines of gateway logs as a file for quick troubleshooting.

<img width="360" src="docs/images/slash-logs.jpg" alt="Logs Demo" />

#### Usage Help

All commands support a `?` suffix to show usage:

> **You**: `/bot-upgrade ?`
>
> **QQBot**: 📖 /bot-upgrade usage: …

#### `/bot-approve` — Approval Configuration

> **You**: `/bot-approve`
>
> **QQBot**: 🔐 Command Execution Approval — Enable / Disable / Strict mode / Reset / View current config

Manage the AI command execution approval policy. Supported subcommands:

| Subcommand | Description |
|------------|-------------|
| `/bot-approve on` | Enable approval (allowlist mode, recommended) |
| `/bot-approve off` | Disable approval — commands execute directly |
| `/bot-approve always` | Strict mode — every execution requires approval |
| `/bot-approve reset` | Restore framework defaults |
| `/bot-approve status` | View current approval config |

#### `/bot-clear-storage` — Clear files generated through QQBot conversations and downloaded resources (stored on the host running OpenClaw)

`/bot-clear-storage` lists files generated by the conversation and files in the downloaded resources directory. Use `/bot-clear-storage --force` to confirm deletion.

#### `/bot-group-always` — Group Response Mode Toggle

> **You**: `/bot-group-always`
>
> **QQBot**: 🤖 Group autonomous mode: ❌ @mention required

Toggle group @trigger behavior at runtime — changes persist instantly, no restart needed:

| Subcommand | Description |
|------------|-------------|
| `/bot-group-always on` | AI decides when to speak autonomously (no @ needed) |
| `/bot-group-always off` | Only respond when @mentioned |
| `/bot-group-always` (no arg) | View current setting |

> ⚠️ This command modifies the account-level `defaultRequireMention`. It has lower priority than per-group `groups.{groupId}.requireMention` settings.

---

## 🚀 Getting Started

### Step 1 — Create a QQ Bot on the QQ Open Platform

1. Go to the [QQ Open Platform](https://q.qq.com/) and **scan the QR code with your phone QQ** to register / log in. If you haven't registered before, scanning will automatically complete the registration and bind your QQ account.

<img width="3246" height="1886" alt="Clipboard_Screenshot_1772980354" src="https://github.com/user-attachments/assets/d8491859-57e8-47e4-9d39-b21138be54d0" />

2. After scanning, tap **Agree** on your phone — you'll land on the bot configuration page.
3. Click **Create Bot** to create a new QQ bot.

<img width="720" alt="Create Bot" src="docs/images/create-robot.png" />

> ⚠️ The bot will automatically appear in your QQ message list and send a first message. However, it will reply "The bot has gone to Mars" until you complete the configuration steps below.

<img width="400" alt="Bot Say Hello" src="docs/images/bot-say-hello.jpg" />

4. Find **AppID** and **AppSecret** on the bot's page, click **Copy** for each, and save them somewhere safe (e.g., a notepad). **AppSecret is not stored in plaintext — if you leave the page without saving it, you'll have to regenerate a new one.**

<img width="720" alt="Find AppID and AppSecret" src="docs/images/find-appid-secret.png" />

> For a step-by-step walkthrough with screenshots, see the [official guide](https://cloud.tencent.com/developer/article/2626045).

### Step 2 — Install / Upgrade the Plugin

> **Note**: This is a forked version, not published to npm. Install from GitHub.

**Option A: Install from GitHub (Recommended)**

```bash
# Install directly from GitHub
openclaw plugins install git+https://github.com/jerryliang122/openclaw-qqbot.git

# Or install a specific branch/tag
openclaw plugins install git+https://github.com/jerryliang122/openclaw-qqbot.git#refactor/channel-plugin-standard
```

**Option B: Install from Local Source**

```bash
# Clone the repo
git clone https://github.com/jerryliang122/openclaw-qqbot.git
cd openclaw-qqbot

# Build
npm install
npm run build

# Install to OpenClaw (method 1: link)
openclaw plugins link .

# Or install to OpenClaw (method 2: pack)
npm pack
openclaw plugins install ./openclaw-qqbot-2.1.0.tgz
```

**Option C: Configure Credentials**

After installation, configure your QQ bot credentials:

```bash
# Via QR code (recommended)
openclaw channels login --channel qqbot

# Or manually
openclaw channels add --channel qqbot --token "AppID:AppSecret"

# Start / restart
openclaw gateway restart
```

> Environment variables `QQBOT_APPID` / `QQBOT_SECRET` are also supported.

> **For the official version**: See [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot)

### Step 3 — Test

Open QQ, find your bot, and send a message!

<div align="center">
<img width="500" alt="Chat Demo" src="https://github.com/user-attachments/assets/b2776c8b-de72-4e37-b34d-e8287ce45de1" />
</div>

---

## ⚙️ Advanced Configuration

### Multi-Account Setup (Multi-Bot)

Run multiple QQ bots under a single OpenClaw instance.

#### Configuration

Edit `~/.openclaw/openclaw.json` and add an `accounts` field under `channels.qqbot`:

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "111111111",
      "clientSecret": "secret-of-bot-1",

      "accounts": {
        "bot2": {
          "enabled": true,
          "appId": "222222222",
          "clientSecret": "secret-of-bot-2"
        },
        "bot3": {
          "enabled": true,
          "appId": "333333333",
          "clientSecret": "secret-of-bot-3"
        }
      }
    }
  }
}
```

**Notes:**

- The top-level `appId` / `clientSecret` is the **default account** (accountId = `"default"`)
- Each key under `accounts` (e.g. `bot2`, `bot3`) is the `accountId` for that bot
- Each account can independently configure `enabled`, `name`, `allowFrom`, `systemPrompt`, etc.
- You may also skip the top-level default account and only configure bots inside `accounts`

Add a second bot via CLI (if the framework supports the `--account` parameter):

```bash
openclaw channels add --channel qqbot --account bot2 --token "222222222:secret-of-bot-2"
```

#### Sending Messages to a Specific Account's Users

When using `openclaw message send`, specify which bot to use with the `--account` parameter:

```bash
# Send with the default bot (no --account = uses "default")
openclaw message send --channel "qqbot" \
  --target "qqbot:c2c:OPENID" \
  --message "hello from default bot"

# Send with bot2
openclaw message send --channel "qqbot" \
  --account bot2 \
  --target "qqbot:c2c:OPENID" \
  --message "hello from bot2"
```

**Target Formats:**

| Format | Description |
|--------|-------------|
| `qqbot:c2c:OPENID` | Private chat (C2C) |
| `qqbot:group:GROUP_OPENID` | Group chat |
| `qqbot:channel:CHANNEL_ID` | Guild channel |

> ⚠️ **Important**: Each bot has its own set of user OpenIDs. An OpenID received by Bot A **cannot** be used to send messages via Bot B — this will result in a 500 error. Always use the matching bot's `accountId` to send messages to its users.

#### How It Works

- When `openclaw gateway` starts, all accounts with `enabled: true` launch their own connections (WebSocket or Webhook depending on `transport` config)
- Each account maintains an independent Token cache (isolated by `appId`), preventing cross-contamination
- Incoming message logs are prefixed with `[qqbot:accountId]` for easy debugging

---

### Webhook Transport Mode

By default, the plugin connects to QQ via **WebSocket** (outbound connection, no public IP required). You can switch to **Webhook** mode where QQ platform POSTs events to your HTTP endpoint.

| | WebSocket (default) | Webhook |
|---|---|---|
| Connection | Plugin connects to QQ gateway | QQ platform POSTs to your server |
| Public IP | Not required | Required |
| Use case | Development, single instance | Production, horizontal scaling, Serverless |
| Session resume | Supported (RESUME) | Stateless, no resume needed |
| Signature | Built-in | Ed25519 auto-verified by plugin |

#### Configuration

```json
{
  "channels": {
    "qqbot": {
      "appId": "111111111",
      "clientSecret": "your-secret",
      "transport": "webhook",
      "webhook": {
        "path": "/qqbot/webhook"
      }
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `transport` | `"websocket"` | `"websocket"` or `"webhook"` |
| `webhook.path` | `"/qqbot/webhook"` | HTTP path for receiving callbacks |

#### Platform Setup

1. Go to [QQ Open Platform](https://q.qq.com/) → Bot Settings → Message Receiving
2. Select **HTTP Callback**
3. Enter your callback URL: `https://your-domain.com/qqbot/webhook`
4. The platform sends an `op:13` validation request — the plugin handles it automatically
5. Once validated, all events will be POSTed to your endpoint

---

### Group Chat Configuration

The plugin provides flexible group chat controls, allowing you to customize trigger rules, tool permissions, and AI behavior per group.

#### @Mention Trigger Mode (`requireMention`)

By default, the bot **only responds when @mentioned** in a group. You can configure it to autonomously decide when to speak:

| Mode | Config Value | Behavior |
|------|-------------|----------|
| **@ only** | `true` (default) | Only messages that @mention the bot trigger AI processing. Non-@ messages are still cached in history but don't trigger AI |
| **Autonomous** | `false` | AI decides on its own whether each message needs a reply — no @ required |

> **Important**: Even when `requireMention: true`, non-@ messages are **still cached** in the group history buffer. They just don't trigger AI processing.

**Priority chain** (highest to lowest):

```
groups.{groupOpenid}.requireMention
  > groups."*".requireMention
    > account-level defaultRequireMention
      > default value true
```

**Example:**

```json
{
  "channels": {
    "qqbot": {
      // Account-level default for all groups
      "defaultRequireMention": false,

      "accounts": {
        "default": {
          "groups": {
            "*": {
              // Wildcard fallback for all groups
              "requireMention": false
            },
            "GROUP_OPENID": {
              // Per-group override — this group still requires @
              "requireMention": true
            }
          }
        }
      }
    }
  }
}
```

> **Use cases:**
>
> - Work groups → `requireMention: true` — avoid AI chiming in on every casual message
> - Dedicated AI companion groups → `requireMention: false` — participate naturally like a real person
> - Use [`/bot-group-always`](#bot-group-always--group-response-mode-toggle) to toggle account-level defaults at runtime

#### Additional Group Config Fields

Besides `requireMention`, each group supports these settings:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ignoreOtherMentions` | `boolean` | `false` | If enabled, messages that @mention others but not the bot are silently dropped (not recorded, no AI trigger) |
| `toolPolicy` | `"full" \| "restricted" \| "none"` | `"restricted"` | Tool scope available to AI in this group. `full`=all tools; `restricted`=sensitive tools restricted (e.g., command execution, file ops); `none`=no tool calls allowed |
| `prompt` | `string` | built-in default | Group-specific system prompt, appended after global systemPrompt |
| `historyLimit` | `number` | `50` | Cached group history message count |
| `coalesce` | `object` | `{enabled: true, maxBuffer: 50}` | Message coalescing config for this group (see below) |

**Full example with multiple groups:**

```json
{
  "channels": {
    "qqbot": {
      "defaultRequireMention": false,
      "accounts": {
        "default": {
          "groups": {
            "*": {
              "requireMention": true,
              "toolPolicy": "restricted",
              "ignoreOtherMentions": true
            },
            "WORK_GROUP_OPENID": {
              "requireMention": true,
              "toolPolicy": "none",
              "prompt": "You are a work assistant. Only answer work-related questions."
            },
            "FRIEND_GROUP_OPENID": {
              "requireMention": false,
              "toolPolicy": "full",
              "prompt": "You are a friend in the group. Chat casually and naturally."
            }
          }
        }
      }
    }
  }
}
```

#### Group Access Control (`groupPolicy`)

Control which groups are allowed via `groupPolicy`:

| Policy | Description |
|--------|-------------|
| `"open"` (default) | All groups are allowed |
| `"allowlist"` | Only groups in `groupAllowFrom` are allowed |
| `"disabled"` | Group chats are disabled entirely |

```json
{
  "channels": {
    "qqbot": {
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["ALLOWED_GROUP_OPENID_1", "ALLOWED_GROUP_OPENID_2"]
    }
  }
}
```

> You can also use [**`/bot-group-always`**](#bot-group-always--group-response-mode-toggle) to toggle account-level defaults at runtime without restarting.

---

### Group vs C2C Differential Handling

The plugin implements different message handling strategies for group and private chats:

#### Group Chat (Coalescing Strategy)

- **All messages are processed** — nothing is dropped
- **Fast messages are merged** — when multiple messages arrive quickly, they are combined into one context
- **SessionKey format**: `qqbot:{accountId}:group:{groupId}:coalescing`
- **Admission strategy**: `cancel-only` — doesn't cancel ongoing tasks

**Example behavior**:

```
User A: "Question 1"  → Start processing
User B: "Question 2"  → Buffer and wait
User C: "Question 3"  → Buffer and wait

Question 1 completes → Merge [Q1, Q2, Q3] → AI sees combined context
```

#### C2C Private Chat (Exclusive Strategy)

- **User can interrupt** — sending a new message cancels the previous one
- **Last message wins** — only the most recent message is processed
- **SessionKey format**: `qqbot:{accountId}:{userId}`
- **Admission strategy**: `exclusive` — new message cancels old

**Example behavior**:

```
User A: "Question 1"  → Start processing
User A: "Question 2"  → Cancel Q1, start processing Q2
```

#### Why This Design?

- **In groups**: All user messages should be preserved and addressed
- **In C2C**: Users can change their mind mid-conversation
- **Aligns with user expectations** in different chat contexts

---

### Message Coalescing Configuration (`groupCoalesce`)

Control how group messages are merged when they arrive in quick succession:

```json
{
  "channels": {
    "qqbot": {
      "groupCoalesce": {
        "enabled": true,
        "maxBuffer": 50
      },
      "accounts": {
        "default": {
          "groups": {
            "GROUP_123": {
              "coalesce": {
                "maxBuffer": 100
              }
            }
          }
        }
      }
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable message coalescing |
| `maxBuffer` | `number` | `50` | Maximum number of messages to buffer per group |

**Priority chain**: `groups.{groupId}.coalesce` > `groupCoalesce` (account-level) > defaults

**When enabled**:

- Fast messages in groups are buffered and merged
- The AI sees combined context with clear formatting:
  ```
  [Merged messages begins]
  [User A] Question 1
  [User B] Question 2
  [Merged messages ends]
  [Current message]
  [User C] Question 3 (@you)
  ```
- Prevents message loss and ensures all user input is addressed

**Configuration example**:

```json
{
  "channels": {
    "qqbot": {
      "groupCoalesce": {
        "enabled": true,
        "maxBuffer": 50
      },
      "accounts": {
        "default": {
          "groups": {
            "*": {
              "coalesce": {
                "maxBuffer": 50
              }
            },
            "HIGH_TRAFFIC_GROUP": {
              "coalesce": {
                "maxBuffer": 100
              }
            }
          }
        }
      }
    }
  }
}
```

---

### Middleware Execution Order

The plugin processes messages through a carefully ordered middleware chain:

1. **Error Handler** — Catches exceptions at the outermost layer
2. **Message Filter** — Bot echo + message deduplication
3. **Policy Injector** — Injects `ctx.state.policy` with dynamic config
4. **History Buffer** — Caches all group messages (including non-@)
5. **Access Control** — Dynamic pairing/allowlist checks
6. **Mention Gate** — Filters based on @mention rules
7. **Content Sanitizer** — Strips @markers, parses face tags
8. **Rate Limiter** — Three-layer throttling
9. **Slash Commands** — Intercepts `/bot-*` commands
10. **Message Coalescer** (groups only) — Merges fast messages
11. **Typing Indicator** (C2C only) — Shows "typing..." status
12. **Quote Reference** — Parses quoted message context
13. **Attachment Processor** — Downloads/converts media
14. **Envelope Formatter** — Builds final message body

**Key points**:

- History buffer runs **before** mention gate → all messages are cached
- Message coalescer only runs for **group** messages
- Typing indicator only runs for **C2C** messages

---

#### STT (Speech-to-Text) — Transcribe Incoming Voice Messages

STT supports two-level configuration with priority fallback:

| Priority | Config Path | Scope |
|----------|------------|-------|
| 1 (highest) | `channels.qqbot.stt` | Plugin-specific |
| 2 (fallback) | `tools.media.audio.models[0]` | Framework-level |

```json
{
  "channels": {
    "qqbot": {
      "stt": {
        "provider": "your-provider",
        "model": "your-stt-model"
      }
    }
  }
}
```

- `provider` — references a key in `models.providers` to inherit `baseUrl` and `apiKey`
- Set `enabled: false` to disable
- When configured, incoming voice messages are automatically converted (SILK→WAV) and transcribed
- `asrFallback` — platform ASR (`asr_refer_text`) participation switch. Unless explicitly set to `true`, QQ's built-in platform transcript is **discarded in all cases**: not used as a fallback when your STT fails or returns empty, and not used as the sole source when STT is not configured at all (voice messages then render as `[Voice message - transcription unavailable]`; the audio URL is still referenced via the `- Voice:` line). The flag is read from `channels.qqbot.stt.asrFallback` regardless of whether STT credentials resolve — `stt: { "asrFallback": true }` alone restores the legacy platform-transcript behavior:

```json
{
  "channels": {
    "qqbot": {
      "stt": {
        "provider": "your-provider",
        "model": "your-stt-model",
        "asrFallback": true
      }
    }
  }
}
```

#### TTS (Text-to-Speech) — Send Voice Messages

| Priority | Config Path | Scope |
|----------|------------|-------|
| 1 (highest) | `channels.qqbot.tts` | Plugin-specific |
| 2 (fallback) | `messages.tts` | Framework-level |

```json
{
  "channels": {
    "qqbot": {
      "tts": {
        "provider": "your-provider",
        "model": "your-tts-model",
        "voice": "your-voice"
      }
    }
  }
}
```

- `provider` — references a key in `models.providers` to inherit `baseUrl` and `apiKey`
- `voice` — voice variant
- Set `enabled: false` to disable (default: `true`)
- When configured, AI can generate and send voice messages

#### Typing Indicator — C2C private chat only

After receiving a private message, the bot shows "typing…" and renews it periodically while the AI is processing.

```json
{
  "channels": {
    "qqbot": {
      "typing": {
        "enabled": true,
        "intervalMs": 20000
      }
    }
  }
}
```

- `enabled` — enable/disable the indicator (default: `true`)
- `intervalMs` — renewal interval in milliseconds (default: `20000`). The QQ client clears the indicator when the user leaves and re-enters the chat; only a fresh push re-shows it, hence the periodic renewal. Values below `20000` are clamped to `20000` (QPS constraint)
- **Quota note**: typing notifications share the passive-reply quota of the user message they reply to (QQ Open Platform allows ~5 passive replies per message). Once the passive quota is exhausted, typing — just like reply messages — automatically falls back to proactive sending (no msg_id); renewal is never interrupted
- **Intermediate-message refresh**: when the bot sends a message (e.g. chain-of-thought intermediate output), the QQ client terminates the indicator; if the framework task is still running, the plugin renews the indicator 5 seconds after the message (still guarded by the 20s QPS spacing). After the final reply completes the task, no further refresh is sent

---

## 📚 Documentation & Links

- [Upgrade Guide](docs/UPGRADE_GUIDE.md) — full upgrade paths and migration notes
- [Command Reference](docs/commands.md) — OpenClaw CLI commands
- [Changelog](CHANGELOG.md) — release notes

## 🤝 Contributors

This is a forked version. For contributors to the official version, see [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot/graphs/contributors).

<a href="https://github.com/jerryliang122/openclaw-qqbot/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=jerryliang122/openclaw-qqbot" />
</a>

## 💖 Acknowledgements

- Original project: [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot)
- Special thanks to [@sliverp](https://github.com/sliverp) for outstanding contributions to the original project!
- Thanks to [Tencent Cloud Lighthouse](https://cloud.tencent.com/product/lighthouse) for the deep collaboration.

<a href="https://cloud.tencent.com/product/lighthouse">
  <img alt="Tencent Cloud Lighthouse" src="./docs/images/lighthouse-head.png" height="500" style="max-width:80%; height:auto;"/>
</a>

## ⭐ Star History

<div align="center">

[![Star History Chart](https://api.star-history.com/svg?repos=jerryliang122/openclaw-qqbot&type=date&legend=top-left)](https://www.star-history.com/#jerryliang122/openclaw-qqbot&type=date&legend=top-left)

</div>
