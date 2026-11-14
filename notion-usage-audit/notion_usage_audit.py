#!/usr/bin/env python3
"""Count which Notion features you actually use, from the desktop app's local cache.

Reads notion.db read-only and prints TYPES and COUNTS only: block types, database view
types, property types, and how many comments, templates, public pages and automations
exist. It never prints titles, page text or URLs (link domains are opt-in with --domains).

Useful before migrating off Notion, trimming a plan, or rebuilding the parts you need.
Standard library only. The cache schema is undocumented and may change between versions.
"""
import argparse
import json
import os
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import quote


def default_db_paths():
    home = Path.home()
    return [
        home / "Library/Application Support/Notion/notion.db",          # macOS
        Path(os.environ.get("APPDATA", home / "AppData/Roaming")) / "Notion/notion.db",  # Windows
        home / ".config/Notion/notion.db",                               # Linux (unofficial builds)
    ]


def open_readonly(path):
    # immutable=1 stops SQLite from touching the WAL or taking locks while Notion is running.
    uri = "file:" + quote(str(path)) + "?mode=ro&immutable=1"
    return sqlite3.connect(uri, uri=True)


def has_table(con, name):
    return con.execute(
        "select 1 from sqlite_master where type='table' and name=?", (name,)
    ).fetchone() is not None


def columns(con, table):
    return {r[1] for r in con.execute(f"pragma table_info({table})")}


def count_rows(con, table):
    if not has_table(con, table):
        return None
    return con.execute(f"select count(*) from {table}").fetchone()[0]


def alive_clause(con, table):
    return " where alive=1" if "alive" in columns(con, table) else ""


def audit(con, with_domains=False):
    report = {}

    block_alive = alive_clause(con, "block")
    report["blocks_total"] = con.execute(f"select count(*) from block{block_alive}").fetchone()[0]
    report["block_types"] = dict(con.execute(
        f"select type, count(*) from block{block_alive} group by type order by 2 desc"
    ).fetchall())

    if has_table(con, "collection_view"):
        alive = alive_clause(con, "collection_view")
        report["view_types"] = dict(con.execute(
            f"select type, count(*) from collection_view{alive} group by type order by 2 desc"
        ).fetchall())

    prop_types = Counter()
    db_sizes = []
    if has_table(con, "collection"):
        alive = alive_clause(con, "collection")
        for cid, schema in con.execute(f"select id, schema from collection{alive}"):
            props = json.loads(schema or "{}")
            prop_types.update(p.get("type", "?") for p in props.values())
            rows = con.execute(
                "select count(*) from block where parent_table='collection' and parent_id=?"
                + (" and alive=1" if block_alive else ""), (cid,)
            ).fetchone()[0]
            db_sizes.append({"rows": rows, "properties": len(props),
                             "property_types": sorted({p.get("type", "?") for p in props.values()})})
    report["property_types"] = dict(prop_types.most_common())
    report["databases"] = sorted(db_sizes, key=lambda d: -d["rows"])

    cols = columns(con, "block")
    where = block_alive or " where 1=1"
    if "is_template" in cols:
        report["templates"] = con.execute(f"select count(*) from block{where} and is_template=1").fetchone()[0]
    if "permissions" in cols:
        report["public_pages"] = con.execute(
            f"select count(*) from block{where} and permissions like '%public_permission%'"
        ).fetchone()[0]
    if "properties" in cols:
        # Rich-text annotations: "a" = link, "d" = date mention, "p" = page mention, "u" = user mention.
        for key, label in (("a", "blocks_with_links"), ("d", "date_mentions"),
                           ("p", "page_mentions"), ("u", "user_mentions")):
            report[label] = con.execute(
                f"select count(*) from block{where} and properties like ?", (f'%["{key}",%',)
            ).fetchone()[0]

    report["other_tables"] = {t: n for t in (
        "comment", "discussion", "reaction", "automation", "workflow", "bot", "custom_emoji", "notification"
    ) if (n := count_rows(con, t)) is not None}

    if with_domains and "properties" in cols:
        domains = Counter()
        for (props,) in con.execute(f"select properties from block{where} and properties like '%[\"a\",%'"):
            domains.update(m.lower().removeprefix("www.")
                           for m in re.findall(r'\["a","https?://([^/"?#]+)', props or ""))
        report["link_domains"] = dict(domains.most_common(25))

    return report


def print_text(r):
    def section(title, mapping):
        print(f"\n{title}")
        if not mapping:
            print("  (none)")
        for k, v in mapping.items():
            print(f"  {v:>7}  {k}")

    print(f"Live blocks: {r['blocks_total']}")
    section("Block types", r["block_types"])
    section("Database view types", r.get("view_types", {}))
    section("Database property types", r["property_types"])
    print("\nDatabases (largest first)")
    for d in r["databases"]:
        print(f"  {d['rows']:>7} rows  {d['properties']:>3} props  {', '.join(d['property_types'])}")
    section("Feature signals", {k: r[k] for k in (
        "templates", "public_pages", "blocks_with_links", "date_mentions", "page_mentions", "user_mentions"
    ) if k in r})
    section("Other records", r["other_tables"])
    if "link_domains" in r:
        section("Link domains (top 25)", r["link_domains"])


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", type=Path, help="path to notion.db (auto-detected if omitted)")
    ap.add_argument("--json", action="store_true", help="print JSON instead of text")
    ap.add_argument("--domains", action="store_true", help="also count link domains (no full URLs)")
    args = ap.parse_args()

    path = args.db or next((p for p in default_db_paths() if p.exists()), None)
    if not path or not path.exists():
        sys.exit("notion.db not found. Install the Notion desktop app or pass --db PATH.")
    con = open_readonly(path)
    if not has_table(con, "block"):
        sys.exit(f"{path} has no block table; this Notion version uses an unknown cache layout.")

    report = audit(con, with_domains=args.domains)
    print(json.dumps(report, indent=2) if args.json else "", end="")
    if not args.json:
        print_text(report)


if __name__ == "__main__":
    main()
