# dsh-usage-strip

Ambient plan-limit strip for the DeepSeek Harness Web UI: shows **OpenCode Go** and
**Kimi Code** quota windows side by side in the composer dock, right next to the
token/cache stats.

```
GO 5h 8% · 周 3% · 月 47%   │   Kimi 5h 4% · 月 21%
```

## What it does

- Registers one slot entry in `conversation.composer.dock` (order `2`), so it sits
  after the shipped `activity` and `usage` cells and before the context meter.
- The Host serves one same-origin route, `GET /usage-strip/usage`, that fans out to
  both providers, caches the snapshot for 60 s, and never exposes a key to the page.
- The page polls every 60 s (paused while hidden), refreshes on window focus, and
  force-refreshes on click. Colors: `<70%` secondary, `70–89%` warn, `≥90%` error.
- A provider without credentials is omitted; with neither configured the strip
  renders nothing at all.

## Providers

| Provider | Endpoint | Credential |
|---|---|---|
| OpenCode Go | `https://opencode.ai/zen/go/v1/usage` | credential ref `OPENCODE_GO_API_KEY` |
| Kimi Code | `https://api.kimi.com/coding/v1/usages` | ref `KIMI_CODE_API_KEY`, else the local Kimi CLI credential |

Kimi Code resolution order:

1. `KIMI_CODE_API_KEY` (a subscription API key), else
2. `~/.kimi-code/credentials/kimi-code.json` (the Kimi Code CLI login). When that
   access token is expired the strip refreshes it through the public Kimi OAuth
   client (`auth.kimi.com`, client id `17e5f671-d194-4dfb-9706-5516cb48c098`) and
   **writes the rotated pair back**, so the CLI keeps working.
3. When the DSH credential record `llm-pi-ai/kimi-coding` exists (the sign-in used
   by the built-in `kimi-coding` model route), that record is preferred and a
   refresh is committed through the credentials store, keeping one source of truth.

Percentages are **used** (not remaining). Hover for the reset time.

## Install

```sh
dsh plugin --profile web add github:quei4r/dsh-usage-strip
```

Restart the GUI once (host route) and reload the page (client module). Requires a
DSH build with the Web app bundle, `conversation.composer.dock`, and the
`ctx.credentials` service.

## Layout

```
index.js           Host: /usage-strip/usage route, provider normalization, cache
client.js          Client: composer-dock strip, polling, i18n (zh/en by navigator.language)
cordis.patch.yml   Bundle patch inserting the `usage-strip` row
locale/{en,zh}.json  Plugin-manager title/description
icon.svg           Plugin icon
```

## Notes

- The strip is display-only: it reads quota, it does not register models. Model
  access comes from the `llm-pi-ai` provider profiles (`opencode-go`, `kimi-coding`).
- Kimi Code rotates refresh tokens on every refresh, so the write-back is what keeps
  a CLI login alive; two independent refreshers on the same chain can race, which is
  why the DSH record is preferred when present.
- Windows: the CLI credential path is resolved from `$HOME`; no Windows-specific
  code is shipped.

## License

MIT
