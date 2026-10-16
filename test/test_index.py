import hashlib
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from index_sessions import collect

A = '11111111-1111-4111-8111-111111111111'
B = '22222222-2222-4222-8222-222222222222'
C = '33333333-3333-4333-8333-333333333333'


class IndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'sessions').mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def rollout(self, thread_id, parent=None, contexts=()):
        meta = dict(id=thread_id, cwd='D:\\研究', timestamp='2026-10-16T00:00:00Z')
        if parent:
            meta['forked_from_id'] = parent
        records = [dict(type='session_meta', payload=meta)]
        records += [dict(type='turn_context', payload=ctx) for ctx in contexts]
        target = self.root / 'sessions' / (thread_id + '.jsonl')
        target.write_text(''.join(json.dumps(record) + '\n' for record in records), encoding='utf-8')
        return target

    @contextmanager
    def database(self):
        connection = sqlite3.connect(self.root / 'state_5.sqlite')
        connection.execute('CREATE TABLE threads(id TEXT,title TEXT,model TEXT,reasoning_effort TEXT,archived INTEGER,history_mode TEXT,rollout_path TEXT)')
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def test_fork_and_latest_context_and_no_writes(self):
        self.rollout(A)
        self.rollout(B, A, [{'model': 'old', 'effort': 'low'}, {'model': 'new', 'effort': 'xhigh'}])
        index = self.root / 'session_index.jsonl'
        index.write_text(json.dumps({'id': B, 'thread_name': '分支主题'}) + '\n', encoding='utf-8')
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()}
        items = {n['id']: n for n in collect(self.root)['nodes']}
        self.assertEqual((items[B]['parentId'], items[B]['relation'], items[B]['model'], items[B]['effort']), (A, 'fork', 'new', 'xhigh'))
        self.assertEqual(items[B]['title'], '分支主题')
        self.assertIsNone(items[A]['model'])
        self.assertEqual(before, {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()})

    def test_database_metadata_and_missing_history_are_not_guessed(self):
        with self.database() as db:
            db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?)', (A, 'same title', 'db-model', 'high', 0, 'legacy', 'gone'))
            db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?)', (B, 'same title', None, None, 0, 'legacy', 'gone'))
        data = {n['id']: n for n in collect(self.root)['nodes']}
        self.assertIsNone(data[A]['parentId'])
        self.assertEqual(data[A]['relation'], 'unknown')
        self.assertFalse(data[A]['available'])
        self.assertEqual(data[A]['model'], 'db-model')

    def test_db_latest_metadata_takes_priority_over_inherited_turns(self):
        self.rollout(B, A, [{'model': 'inherited', 'effort': 'low'}])
        with self.database() as db:
            db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?)', (B, 'B', 'latest', 'ultra', 0, 'legacy', 'moved'))
        data = {n['id']: n for n in collect(self.root)['nodes']}
        self.assertEqual((data[B]['model'], data[B]['effort']), ('latest', 'ultra'))
        self.assertTrue(data[A]['missing'])
        self.assertFalse(data[A]['available'])
        self.assertTrue(data[B]['available'])

    def test_cycle_is_reported_and_broken(self):
        self.rollout(A, B)
        self.rollout(B, A)
        result = collect(self.root)
        self.assertEqual(sum(n['parentId'] is not None for n in result['nodes']), 1)
        self.assertTrue(result['warnings'])

    def test_incomplete_live_tail_is_ignored_and_header_failure_visible(self):
        file = self.rollout(A, contexts=[{'model': 'recorded', 'effort': 'medium'}])
        with file.open('a', encoding='utf-8') as stream:
            stream.write('{"type":"turn_context","payload":')
        (self.root / 'sessions' / 'bad.jsonl').write_text('{', encoding='utf-8')
        result = collect(self.root)
        self.assertEqual(result['nodes'][0]['model'], 'recorded')
        self.assertEqual(len(result['warnings']), 1)


if __name__ == '__main__':
    unittest.main()
