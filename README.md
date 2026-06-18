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

For LAN/mobile access from another device, listen on all interfaces:

```bash
./install-linux.sh --host 0.0.0.0 --port 3652
```

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
- start the app in the background with logs at `logs/app.log`.

Before first real use, edit `config.json` and set `claude.apiKey` plus `claude.baseUrl` if you use a custom Anthropic-compatible gateway.

## Local config

Edit `config.json`. Values are injected only into the Claude CLI child process; the app does not write global environment variables.

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 3652
  },
  "claude": {
    "cwd": "..",
    "apiKey": "sk-ant-...",
    "baseUrl": "https://your-anthropic-compatible-gateway.example.com",
    "model": "",
    "extraArgs": [],
    "skipPermissions": false,
    "bare": false,
    "env": {}
  }
}
```

Important fields:

- `claude.apiKey` -> injected as `ANTHROPIC_API_KEY`.
- `claude.baseUrl` -> injected as `ANTHROPIC_BASE_URL`.
- `claude.cwd` -> working directory Claude CLI can see; `..` means `E:\LittleTools` from this project.
- `claude.command` -> optional full Claude executable path; leave empty to auto-detect `claude.cmd`.
- `claude.extraArgs` -> extra Claude CLI flags, for example `["--model", "sonnet"]` if needed.
- `server.port` -> defaults to `3652`.

`config.json` is ignored by git because it can contain secrets. Use `config.example.json` as a template.

## Interactions

Claude CLI permission prompts and MCP elicitation requests are shown as cards above the input box. On mobile, use the menu button to open the sidebar; the chat and interaction cards adapt to narrow screens.
