"""Bounded, read-only excerpts with exact source locations; no inferred conclusions."""
from contextlib import closing
import json
from pathlib import Path
import re
import sqlite3

MAX_BYTES = 8 * 1024 * 1024
MAX_TEXT = 60000


def text_content(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ''
    return '\n'.join(p['text'] for p in content if isinstance(p, dict)
                     and p.get('type') in ('text', 'input_text', 'output_text') and isinstance(p.get('text'), str))


def excerpt(text, source, timestamp=None, final=False):
    return dict(text=text[:MAX_TEXT], source=source, timestamp=timestamp, truncated=len(text) > MAX_TEXT, final=final)


def paginated(root, thread_id):
    path = root / 'thread_history_1.sqlite'
    result = dict(question=None, answer=None, files=[], warnings=[])
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
        db.execute('PRAGMA query_only=ON')
        columns = {r[1] for r in db.execute('PRAGMA table_info(thread_items)')}
        if not {'thread_id', 'turn_id', 'item_id', 'rollout_ordinal', 'created_at_ms', 'item_json', 'item_type'} <= columns:
            raise ValueError('分页历史结构无法识别，无法读取原文预览。')
        rows = db.execute("SELECT turn_id,item_id,created_at_ms,item_json FROM thread_items "
                          "WHERE thread_id=? AND item_type IN ('userMessage','agentMessage','fileChange') "
                          "ORDER BY rollout_ordinal DESC LIMIT 301", (thread_id,)).fetchall()
        if len(rows) > 300:
            result['warnings'].append('预览仅检查最近 300 条对话及文件变更记录。')
        for turn, item_id, timestamp, raw in rows[:300]:
            item = json.loads(raw)
            source = f'{path} · thread_items · turn={turn} · item={item_id}'
            if item.get('type') == 'userMessage' and result['question'] is None:
                text = text_content(item.get('content'))
                if text:
                    result['question'] = excerpt(text, source, timestamp)
            elif item.get('type') == 'agentMessage' and result['answer'] is None:
                if item.get('phase') not in (None, 'final_answer', 'final'):
                    continue
                text = item.get('text')
                if isinstance(text, str) and text:
                    result['answer'] = excerpt(text, source, timestamp, item.get('phase') in ('final_answer', 'final'))
            elif item.get('type') == 'fileChange':
                for change in item.get('changes', []):
                    filename = change.get('path')
                    if filename and filename not in result['files'] and len(result['files']) < 20:
                        result['files'].append(filename)
    return result


def jsonl(path, thread_id):
    result = dict(question=None, answer=None, files=[], warnings=[])
    with path.open('rb') as stream:
        head = json.loads(stream.readline(4 * 1024 * 1024))
        meta = head.get('payload', {})
        if head.get('type') != 'session_meta' or (meta.get('id') or meta.get('session_id')) != thread_id:
            raise ValueError('历史文件的会话 ID 不匹配，已停止读取。')
        stream.seek(0, 2)
        start = max(0, stream.tell() - MAX_BYTES)
        stream.seek(start)
        if start:
            stream.readline()
            start = stream.tell()
            result['warnings'].append('预览仅检查历史末尾 8 MiB，较早内容可能未包含。')
        records, offset = [], start
        for line in stream:
            try:
                records.append((offset, json.loads(line)))
            except (json.JSONDecodeError, UnicodeDecodeError):
                result['warnings'].append('有尚未写完或无法解析的历史记录，本次已跳过。')
            offset += len(line)
    for offset, record in reversed(records):
        item = record.get('payload', {})
        kind = record.get('type')
        source = f'{path} · byte={offset}'
        timestamp = record.get('timestamp')
        role, text, final = None, '', False
        if kind == 'response_item' and item.get('type') == 'message':
            role, text = item.get('role'), text_content(item.get('content'))
            phase = item.get('phase') or item.get('channel')
            if role == 'assistant' and phase not in (None, 'final', 'final_answer'):
                continue
            final = phase in ('final', 'final_answer')
        elif kind == 'event_msg' and item.get('type') in ('user_message', 'agent_message'):
            role = 'user' if item['type'] == 'user_message' else 'assistant'
            text, phase = item.get('message', ''), item.get('phase')
            if role == 'assistant' and phase not in (None, 'final', 'final_answer'):
                continue
            final = phase in ('final', 'final_answer')
        if role in ('user', 'assistant') and isinstance(text, str) and text:
            field = 'question' if role == 'user' else 'answer'
            if result[field] is None:
                result[field] = excerpt(text, source, timestamp, final)
        if kind == 'response_item' and item.get('name') == 'apply_patch':
            patch = item.get('input', '')
            if isinstance(patch, str):
                for filename in re.findall(r'^\*\*\* (?:Add|Update|Delete) File: (.+)$', patch, re.M):
                    if filename not in result['files'] and len(result['files']) < 20:
                        result['files'].append(filename)
    result['warnings'] = list(dict.fromkeys(result['warnings']))
    return result


def read_preview(root, thread_id):
    from index_sessions import valid_id
    if not valid_id(thread_id):
        raise ValueError('无效的会话 ID。')
    root = Path(root).expanduser().resolve()
    versions = [(int(m.group(1)), p) for p in root.glob('state_*.sqlite')
                if (m := re.fullmatch(r'state_(\d+)\.sqlite', p.name))]
    rollout = None
    if versions:
        with closing(sqlite3.connect(max(versions)[1].as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
            db.row_factory = sqlite3.Row
            row = db.execute('SELECT * FROM threads WHERE id=?', (thread_id,)).fetchone()
            if row:
                row = dict(row)
                if row.get('history_mode') == 'paginated':
                    if not (root / 'thread_history_1.sqlite').is_file():
                        raise ValueError('分页历史数据库不可用。')
                    return paginated(root, thread_id)
                if row.get('rollout_path'):
                    rollout = Path(row['rollout_path'])
    if rollout and rollout.is_file():
        return jsonl(rollout, thread_id)
    for folder in ('sessions', 'archived_sessions'):
        for path in (root / folder).rglob('*.jsonl'):
            with path.open('rb') as stream:
                try:
                    head = json.loads(stream.readline(4 * 1024 * 1024))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
            meta = head.get('payload', {})
            if head.get('type') == 'session_meta' and (meta.get('id') or meta.get('session_id')) == thread_id:
                return jsonl(path, thread_id)
    raise ValueError('找不到可读取的会话历史。')
