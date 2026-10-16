"""Read local Codex metadata without changing its databases or session files."""
from __future__ import annotations

import argparse
from contextlib import closing
import datetime as dt
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.I)


def valid_id(value):
    return isinstance(value, str) and UUID.fullmatch(value) is not None


def stamp(value):
    if not value:
        return 0
    if isinstance(value, (float, int)):
        return int(value if value > 10**12 else value * 1000)
    try:
        return int(dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, TypeError):
        return 0


def node(thread_id):
    return dict(id=thread_id, title="未命名会话", cwd="", model=None, effort=None,
                createdAt=0, updatedAt=0, parentId=None, relation="unknown", archived=False,
                isAgent=False, available=False, metadataSource="", historyMode="legacy")


def latest_context(path):
    # Old JSONL-only sessions may have no database model fields. Search backwards,
    # with a bounded 8 MiB read; an absent record remains explicitly unknown.
    with path.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        end = stream.tell()
        size = min(end, 8 * 1024 * 1024)
        stream.seek(end - size)
        lines = stream.read(size).splitlines()
    if size < end:
        lines = lines[1:]
    for line in reversed(lines):
        if b'"turn_context"' not in line:
            continue
        try:
            event = json.loads(line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue  # A live writer may not have finished the last line.
        if event.get("type") == "turn_context":
            payload = event.get("payload", {})
            settings = (payload.get("collaboration_mode") or {}).get("settings") or {}
            return payload.get("model") or settings.get("model"), payload.get("effort") or payload.get("reasoning_effort") or settings.get("reasoning_effort")
    return None, None


def read_database(root, nodes, warnings):
    versions = [(int(m.group(1)), p) for p in root.glob("state_*.sqlite")
                if (m := re.fullmatch(r"state_(\d+)\.sqlite", p.name))]
    if not versions:
        return []
    path = max(versions)[1]
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)) as conn:
        conn.execute("PRAGMA query_only=ON")
        conn.row_factory = sqlite3.Row
        columns = {row[1] for row in conn.execute("PRAGMA table_info(threads)")}
        wanted = [key for key in ["id", "title", "name", "cwd", "model", "reasoning_effort", "created_at", "updated_at", "created_at_ms", "updated_at_ms", "archived", "source", "thread_source", "history_mode", "rollout_path"] if key in columns]
        if "id" not in columns:
            raise ValueError(f"{path.name} 中没有可识别的 threads 表")
        for raw in conn.execute("SELECT " + ",".join(wanted) + " FROM threads"):
            row = dict(raw)
            if not valid_id(row["id"]):
                continue
            item = node(row["id"])
            item.update(title=row.get("name") or row.get("title") or item["title"],
                        cwd=row.get("cwd") or "", model=row.get("model"), effort=row.get("reasoning_effort"),
                        createdAt=stamp(row.get("created_at_ms") or row.get("created_at")),
                        updatedAt=stamp(row.get("updated_at_ms") or row.get("updated_at")),
                        archived=bool(row.get("archived")), historyMode=row.get("history_mode") or "legacy",
                        metadataSource=path.name)
            source = row.get("source") or ""
            item["isAgent"] = row.get("thread_source") == "subagent" or "subagent" in source
            # The current Codex paginated format keeps history separately from rollouts.
            item["available"] = item["historyMode"] == "paginated" and (root / "thread_history_1.sqlite").exists()
            rollout = row.get("rollout_path")
            if rollout and Path(rollout).is_file():
                item["available"] = True
            nodes[item["id"]] = item
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "thread_spawn_edges" in tables:
            return list(conn.execute("SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges"))
    return []


def collect(root):
    root = Path(root).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"Codex 数据目录不存在：{root}")
    nodes, warnings = {}, []
    edges = read_database(root, nodes, warnings)
    # Scan actual paths as well as the DB: migrations can leave obsolete rollout paths.
    for folder in ("sessions", "archived_sessions"):
        for path in sorted((root / folder).rglob("*.jsonl")):
            try:
                with path.open("rb") as stream:
                    line = stream.readline(4 * 1024 * 1024)
                event = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                warnings.append(f"会话文件头不完整或无法解析：{path.name}")
                continue
            except FileNotFoundError:
                continue  # A concurrent archive moves the file between directories.
            if event.get("type") != "session_meta":
                warnings.append(f"缺少会话元数据：{path.name}")
                continue
            meta = event.get("payload", {})
            thread_id = meta.get("id") or meta.get("session_id")
            if not valid_id(thread_id):
                continue
            from_db = thread_id in nodes
            item = nodes.setdefault(thread_id, node(thread_id))
            item["available"] = True
            if item["relation"] == "unknown":
                item["relation"] = "root"
            item["cwd"] = item["cwd"] or meta.get("cwd", "")
            item["createdAt"] = item["createdAt"] or stamp(meta.get("timestamp"))
            if not from_db:
                item["archived"] = folder == "archived_sessions"
                item["updatedAt"] = int(path.stat().st_mtime * 1000)
                item["metadataSource"] = "session_meta / turn_context"
            parent = meta.get("forked_from_id")
            if valid_id(parent):
                item.update(parentId=parent, relation="fork")
            source = meta.get("source")
            if isinstance(source, dict) and "subagent" in source:
                item["isAgent"] = True
                sub = source["subagent"]
                spawn = sub.get("thread_spawn", {}) if isinstance(sub, dict) else {}
                parent = spawn.get("parent_thread_id")
                if valid_id(parent) and item["parentId"] is None:
                    item.update(parentId=parent, relation="agent")
            if item["model"] is None or item["effort"] is None:
                model, effort = latest_context(path)
                item["model"] = item["model"] or model
                item["effort"] = item["effort"] or effort
    index = root / "session_index.jsonl"
    if index.is_file():
        with index.open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    warnings.append("会话名称索引有不完整记录，本次已跳过。")
                    continue
                thread_id = entry.get("id")
                if not valid_id(thread_id):
                    continue
                item = nodes.setdefault(thread_id, node(thread_id))
                if entry.get("thread_name"):
                    item["title"] = entry["thread_name"]
    for parent, child in edges:
        if valid_id(parent) and child in nodes:
            item = nodes[child]
            item["isAgent"] = True
            if item["parentId"] is None:
                item.update(parentId=parent, relation="agent")
    for item in list(nodes.values()):
        parent = item["parentId"]
        if parent and parent not in nodes:
            nodes[parent] = node(parent)
            nodes[parent]["title"] = "父会话记录缺失 · " + parent[:8]
            nodes[parent]["missing"] = True
    for item in nodes.values():
        visited, current = set(), item
        while current and current.get("parentId"):
            if current["id"] in visited:
                warnings.append("发现循环关系，已断开异常连线：" + current["id"])
                current.update(parentId=None, relation="unknown")
                break
            visited.add(current["id"])
            current = nodes.get(current["parentId"])
    return {"nodes": list(nodes.values()), "warnings": list(dict.fromkeys(warnings)),
            "scannedAt": int(dt.datetime.now().timestamp() * 1000)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-home", default=os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    args = parser.parse_args()
    try:
        result = collect(args.codex_home)
    except (OSError, sqlite3.Error, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False))
