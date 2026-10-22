import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('caller', Path(__file__).resolve().parents[1] / 'skills/acp-service/scripts/a2a-caller.py')
caller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(caller)


class AsyncCallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.log = self.root / 'root.jsonl'
        self.path = self.root / 'run.json'
        self.report = self.root / 'review.json'
        self.report.write_text(json.dumps({'verdict': 'changes_requested', 'artifactDigest': 'a' * 64,
            'factsChecked': True, 'allSlidesViewed': True, 'issues': ['Page 3 factual boundary'], 'limitations': [], 'evidence': []}))
        self.run = {'phase': 'prepared', 'developmentReady': {'sourceCommit': 'fixture'},
            'rootTranscript': str(self.log), 'originSessionId': 'root',
            'request': {'targetId': 'codex-review', 'clientRequestId': 'stable', 'input': {}},
            'review': {'reportPath': str(self.report), 'artifactDigest': 'a' * 64, 'producerSessionId': 'maker'}}
        self.posts = []
        self.tick = 0
        self.tool('dispatch')

    def row(self, payload):
        self.tick += 1
        with self.log.open('a') as f:
            f.write(json.dumps({'type': 'response_item', 'timestamp': f'2026-10-22T10:00:{self.tick:02d}Z', 'payload': payload}) + '\n')

    def tool(self, name):
        self.row({'type': 'custom_tool_call', 'call_id': name, 'name': 'exec', 'input': name})

    def notify(self, role='user', task='task'):
        self.row({'type': 'message', 'role': role, 'content': [{'type': 'input_text', 'text': json.dumps({
            'noticeId': 'notice', 'originSessionId': 'root', 'remote': 'remote', 'taskId': task})}]})

    def invoke(self, run, method, params):
        self.posts.append((method, params))
        if method == 'execution_submit':
            return {'jobId': 'job', 'attemptId': 'attempt', 'remote': 'remote', 'taskId': 'task', 'submissionStatus': 'accepted'}
        if method == 'execution_get':
            raw = self.report.read_bytes()
            return {'jobId': 'job', 'attemptId': 'attempt', 'taskId': 'task', 'executionStatus': 'completed',
                'resultMetadata': {'producer': '1agents/a2a-host', 'taskId': 'task', 'sessionId': 'independent',
                    'outcome': 'completed', 'validation': {'status': 'passed'},
                    'artifacts': [{'path': str(self.report), 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}]}}
        if method == 'remote_agent_ack': return {'acknowledged': True}
        self.fail(method)

    def dispatch(self):
        return caller.dispatch(self.path, self.run, self.invoke)

    def ready(self):
        self.dispatch()
        self.row({'type': 'message', 'role': 'assistant', 'phase': 'final_answer', 'content': []})
        self.notify()
        self.tool('inspect')
        return caller.inspect(self.path, self.run, 'notice', self.invoke)

    def test_dispatch_is_one_submit_and_must_end_without_get(self):
        result = self.dispatch()
        self.assertTrue(result['mustEndTurn'])
        self.assertEqual([m for m, _ in self.posts], ['execution_submit'])
        with self.assertRaises(ValueError): self.dispatch()
        self.assertEqual(len(self.posts), 1)

    def test_no_query_before_a_real_matching_user_notice(self):
        self.dispatch()
        self.notify(role='assistant')
        self.tool('inspect')
        with self.assertRaises(ValueError): caller.inspect(self.path, self.run, 'notice', self.invoke)
        self.notify(task='other')
        with self.assertRaises(ValueError): caller.inspect(self.path, self.run, 'notice', self.invoke)
        self.assertEqual(len(self.posts), 1)

    def test_four_steps_preserve_quality_rejection_and_ack_after_saved_conclusion(self):
        self.assertTrue(self.ready()['valid'])
        with self.assertRaises(ValueError): caller.inspect(self.path, self.run, 'notice', self.invoke)
        with self.assertRaises(ValueError): caller.acknowledge(self.path, self.run, self.invoke)
        self.tool('record')
        caller.record(self.path, self.run)
        self.assertTrue((self.root / 'processing-conclusion.json').exists())
        self.tool('ack')
        result = caller.acknowledge(self.path, self.run, self.invoke)
        self.assertEqual(result['measurement']['rootToolCalls'], 4)
        self.assertTrue(result['measurement']['strictAsyncFlowPassed'])
        self.assertFalse(self.run['conclusion']['pptBusinessAccepted'])
        self.assertEqual([m for m, _ in self.posts], ['execution_submit', 'execution_get', 'remote_agent_ack'])

    def test_extra_polling_is_counted_and_fails_even_with_five_steps(self):
        self.dispatch()
        self.tool('unexpected-poll')
        self.row({'type': 'message', 'role': 'assistant', 'phase': 'final_answer', 'content': []})
        self.notify()
        self.tool('inspect')
        caller.inspect(self.path, self.run, 'notice', self.invoke)
        self.tool('record')
        caller.record(self.path, self.run)
        self.tool('ack')
        measured = caller.acknowledge(self.path, self.run, self.invoke)['measurement']
        self.assertEqual(measured['rootToolCalls'], 5)
        self.assertTrue(measured['stepBudgetMet'])
        self.assertFalse(measured['strictAsyncFlowPassed'])
        self.assertEqual(measured['callsBeforeNotification'][0]['callId'], 'unexpected-poll')

    def test_unknown_admission_never_resends_or_polls(self):
        def unavailable(run, method, params):
            self.posts.append((method, params))
            raise TimeoutError('acceptance unknown')
        result = caller.dispatch(self.path, self.run, unavailable)
        self.assertEqual(result['phase'], 'admission_unknown')
        self.assertTrue(result['mustEndTurn'])
        with self.assertRaises(ValueError): caller.dispatch(self.path, self.run, unavailable)
        self.assertEqual(len(self.posts), 1)

    def test_four_calls_without_ending_the_dispatch_turn_do_not_pass(self):
        self.dispatch()
        self.notify()
        self.tool('inspect')
        caller.inspect(self.path, self.run, 'notice', self.invoke)
        self.tool('record')
        caller.record(self.path, self.run)
        self.tool('ack')
        result = caller.acknowledge(self.path, self.run, self.invoke)['measurement']
        self.assertEqual(result['rootToolCalls'], 4)
        self.assertFalse(result['rootTurnEndedBeforeNotification'])
        self.assertFalse(result['strictAsyncFlowPassed'])

    def test_invalid_report_binding_is_not_accepted_or_retried(self):
        self.report.write_text(json.dumps({'verdict': 'passed', 'artifactDigest': 'b' * 64, 'issues': []}))
        inspected = self.ready()
        self.assertFalse(inspected['valid'])
        self.assertIn('different PPT version', inspected['errors'][0])
        self.assertEqual([m for m, _ in self.posts], ['execution_submit', 'execution_get'])


if __name__ == '__main__':
    unittest.main()
