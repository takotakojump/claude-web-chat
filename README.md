# Claude Web Chat

A local web UI that talks to your local Claude CLI process. It uses no external npm dependencies.

## Quick start

```powershell
cd E:\LittleTools\claude-web-chat
notepad .\config.json
npm start
```

Open http://127.0.0.1:3652


## Linux one-command install and start

After cloning on Linux:

```bash
cd claude-web-chat
./install-linux.sh
```

For LAN/mobile access from another device, either set `server.host` to `0.0.0.0` in `config.json`, or override it for one launch:

```bash
./install-linux.sh --host 0.0.0.0 --port 3652
```

When `--host` / `--port` are not provided, the script respects `config.json`. Environment variables `HOST` and `PORT` still take precedence if you set them explicitly.

Useful commands:

```bash
./install-linux.sh --status
./install-linux.sh --restart
./install-linux.sh --stop
./install-linux.sh --foreground
```

The script will:

- check/install Node.js and npm with the system package manager when missing;
- create `config.json` from `config.example.json` when missing;
- run `npm install --omit=dev`;
- start the app in the background with logs at `logs/app.log`;
- on restart, clear old listeners from the same project directory that still hold the configured port.

Before first real use, edit `config.json` and set `claude.apiKey` plus `claude.baseUrl` if you use a custom Anthropic-compatible gateway.


## Access password and Google Authenticator

The web UI can require a login before any page, API, or event stream is usable.
Edit `config.json`:

```json
{
  "auth": {
    "enabled": true,
    "password": "change-this-password",
    "sessionHours": 12,
    "totp": {
      "enabled": true,
      "secret": "BASE32_SECRET_FROM_GOOGLE_AUTHENTICATOR"
    }
  }
}
```

When both `auth.password` and `auth.totp.enabled` are set, login requires both the
static password and the 6-digit code from Google Authenticator / Microsoft
Authenticator / 1Password / any TOTP app. If you want dynamic-code-only access,
leave `auth.password` empty and enable TOTP with a secret.

Generate a TOTP secret:

```bash
npm run totp:secret -- your-name@example.com
```

Copy the printed `secret` into `config.json`, then add it manually in Google
Authenticator using the same secret. Restart the server after changing auth
settings:

```bash
./install-linux.sh --restart
```

Optional environment overrides are also supported: `CWC_AUTH_ENABLED`,
`CWC_AUTH_PASSWORD`, `CWC_AUTH_PASSWORD_SHA256`, `CWC_TOTP_ENABLED`, and
`CWC_TOTP_SECRET`.

## Local config

Edit `config.json`. Values are injected only into the Claude CLI child process; the app does not write global environment variables.

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 3652
  },
  "auth": {
    "enabled": false,
    "password": "",
    "totp": {
      "enabled": false,
      "secret": ""
    }
  },
  "claude": {
    "cwd": "..",
    "apiKey": "sk-ant-...",
    "baseUrl": "https://your-anthropic-compatible-gateway.example.com",
    "configDir": "",
    "sessionDir": "",
    "model": "",
    "extraArgs": [],
    "skipPermissions": false,
    "bare": false,
    "env": {}
  }
}
```

Important fields:

- `auth.enabled` -> require login before page/API/SSE access.
- `auth.password` -> optional static access password.
- `auth.totp.secret` -> base32 TOTP secret for Google Authenticator.
- `claude.apiKey` -> injected as `ANTHROPIC_API_KEY`.
- `claude.baseUrl` -> injected as `ANTHROPIC_BASE_URL`.
- `claude.cwd` -> working directory Claude CLI can see; `..` means `E:\LittleTools` from this project.
- `claude.command` -> optional full Claude executable path; leave empty to auto-detect `claude.cmd`.
- `claude.extraArgs` -> extra Claude CLI flags, for example `["--model", "sonnet"]` if needed.
- `claude.configDir` -> Claude config directory, default `~/.claude`.
- `claude.sessionDir` -> optional explicit session directory override.
- `server.host` -> bind address; use `0.0.0.0` for LAN/mobile access.
- `server.port` -> defaults to `3652`.

`config.json` is ignored by git because it can contain secrets. Use `config.example.json` as a template.


## Claude session history

Claude Code stores local project transcripts under `~/.claude/projects/<encoded-cwd>/`.
Claude Web Chat now shows those sessions in the sidebar for the configured
`claude.cwd` project.

From the sidebar you can:

- refresh the session list;
- load a historical session into the chat view;
- continue chatting from the loaded Claude session on the next message;
- delete one session (`<session>.jsonl` plus its same-name sidecar directory);
- clear all sessions for the current configured project.

By default the session directory is derived from `claude.cwd`. Advanced overrides:

```json
{
  "claude": {
    "configDir": "~/.claude",
    "sessionDir": ""
  }
}
```

Set `claude.sessionDir` only if your Claude CLI stores sessions somewhere custom.
The app refuses to delete outside the resolved session directory.

## Interactions

Claude CLI permission prompts, MCP elicitation requests, and Claude Code's `AskUserQuestion` choice prompts are shown as cards above the input box. `AskUserQuestion` supports single choice, multi-select, optional custom "Other" answers, option previews, and notes.

On mobile, use the menu button to open the sidebar; the chat and interaction cards adapt to narrow screens.
