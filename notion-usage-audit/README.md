# notion-usage-audit

Find out which Notion features you really use, from the desktop app's local cache, without
exporting anything or giving a third party your token.

```
python3 notion_usage_audit.py            # auto-finds notion.db
python3 notion_usage_audit.py --json     # machine-readable
python3 notion_usage_audit.py --domains  # also count link domains
```

It prints counts only:

- block types (text, to_do, callout, image, embed ...)
- database view types (table, board, calendar, gallery ...)
- database property types, plus each database's row and property count
- templates, public pages, links, date/page/user mentions
- comments, reactions, automations, workflows, bots

It never prints titles, page text or full URLs.

## Why
Before you migrate off Notion, downgrade a plan, or rebuild a workflow in another tool, you
need to know what you actually depend on. Your gut says "I use databases and embeds". The
cache might say 98% table views and zero embeds.

## Safety
- The database is opened with SQLite `mode=ro&immutable=1`: no writes, no locks, safe while
  Notion is running.
- Standard library only (Python 3.9+), nothing to install, no network.
- The cache holds only what the app has synced to this machine, so pages you never opened
  on this device may be missing.

## Where notion.db lives
| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Notion/notion.db` |
| Windows | `%APPDATA%\Notion\notion.db` |
| Linux (unofficial builds) | `~/.config/Notion/notion.db` |

## Caveats
The cache schema is undocumented and changes between app versions. Tested against Notion
desktop 7.36 on macOS. The script checks for tables and columns before using them, and skips
what it can't find.

Not affiliated with or endorsed by Notion Labs. MIT licensed.
