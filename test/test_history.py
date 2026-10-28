import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from session_history import read_preview, MAX_BYTES, MAX_TEXT

A = '11111111-1111-4111-8111-111111111111'
B = '22222222-2222-4222-8222-222222222222'


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'sessions').mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def rollout(self, events):
        path = self.root / 'sessions' / 'moved.jsonl'
        events = [dict(type='session_meta', payload=dict(id=A))] + events
        path.write_text(''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in events), encoding='utf-8')
        return path

    def message(self, role, text, phase=None):
        return dict(type='response_item', payload=dict(type='message', role=role, phase=phase,
                    content=[dict(type='input_text' if role == 'user' else 'output_text', text=text)]))

    def test_jsonl_extracts_final_not_commentary_or_tools_with_exact_source(self):
        path = self.rollout([self.message('user', '第一个问题'), self.message('assistant', '结论原文', 'final_answer'),
                             self.message('user', '<img src=x>新问题'), self.message('assistant', '正在工作', 'commentary'),
                             dict(type='response_item', payload=dict(type='custom_tool_call', name='apply_patch', input='*** Update File: src/a.py\n'))])
        with path.open('ab') as stream:
            stream.write(b'{"unfinished":')
        before = path.read_bytes()
        result = read_preview(self.root, A)
        self.assertEqual(result['question']['text'], '<img src=x>新问题')
        self.assertEqual(result['answer']['text'], '结论原文')
        self.assertTrue(result['answer']['final'])
        offset = int(result['answer']['source'].split('byte=')[1])
        record = json.loads(before[offset:].splitlines()[0])
        self.assertEqual(record['payload']['content'][0]['text'], '结论原文')
        self.assertEqual(result['files'], ['src/a.py'])
        self.assertTrue(result['warnings'])
        self.assertEqual(path.read_bytes(), before)

    def test_event_messages_and_missing_final_marker_are_explicit(self):
        self.rollout([dict(type='event_msg', payload=dict(type='user_message', message='问题')),
                      dict(type='event_msg', payload=dict(type='agent_message', message='旧格式回复'))])
        result = read_preview(self.root, A)
        self.assertEqual(result['answer']['text'], '旧格式回复')
        self.assertFalse(result['answer']['final'])

    def test_bounded_tail_and_long_message_are_reported(self):
        self.rollout([self.message('user', 'x' * (MAX_BYTES + 100)), self.message('assistant', 'y' * (MAX_TEXT + 10), 'final_answer')])
        result = read_preview(self.root, A)
        self.assertIsNone(result['question'])
        self.assertTrue(result['answer']['truncated'])
        self.assertEqual(len(result['answer']['text']), MAX_TEXT)
        self.assertTrue(result['warnings'])

    def make_databases(self, rollout_path='gone'):
        with sqlite3.connect(self.root / 'state_5.sqlite') as db:
            db.execute('CREATE TABLE threads(id TEXT,history_mode TEXT,rollout_path TEXT)')
            db.execute('INSERT INTO threads VALUES(?,?,?)', (A, 'paginated', rollout_path))
        db.close()
        with sqlite3.connect(self.root / 'thread_history_1.sqlite') as db:
            db.execute('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT,item_type TEXT)')
            items = [(A, dict(type='userMessage', content=[dict(type='text', text='数据库问题')])),
                     (A, dict(type='agentMessage', text='最终答复', phase='final_answer')),
                     (A, dict(type='agentMessage', text='新轮进度', phase='commentary')),
                     (B, dict(type='agentMessage', text='另一会话', phase='final_answer')),
                     (A, dict(type='fileChange', changes=[dict(path='main.py', diff='not user text')]))]
            for i, (thread, item) in enumerate(items):
                db.execute('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)', (thread, 'turn1', f'item{i}', i, i * 1000, json.dumps(item), item['type']))
        db.close()

    def test_paginated_preferred_over_old_rollout_and_never_written(self):
        old = self.rollout([self.message('assistant', 'stale', 'final_answer')])
        self.make_databases(str(old))
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()}
        result = read_preview(self.root, A)
        self.assertEqual(result['answer']['text'], '最终答复')
        self.assertEqual(result['question']['text'], '数据库问题')
        self.assertIn('item=item1', result['answer']['source'])
        self.assertEqual(result['files'], ['main.py'])
        after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)

    def test_invalid_missing_or_incompatible_history_does_not_invent_content(self):
        with self.assertRaisesRegex(ValueError, '无效'):
            read_preview(self.root, '../anything')
        with self.assertRaisesRegex(ValueError, '找不到'):
            read_preview(self.root, A)
        self.make_databases()
        with sqlite3.connect(self.root / 'thread_history_1.sqlite') as db:
            db.execute('DROP TABLE thread_items')
        db.close()
        with self.assertRaisesRegex(ValueError, '结构无法识别'):
            read_preview(self.root, A)


if __name__ == '__main__':
    unittest.main()
