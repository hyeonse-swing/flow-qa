import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { QAReport } from '../src/report.ts';
import { EvidenceError, readEvidence } from '../src/ui/evidence.ts';

test('evidence serves only approved report-selected files inside the run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'flowqa-evidence-'));
  const run = path.join(root, 'run');
  await mkdir(path.join(run, 'raw', 'artifacts', 'case'), { recursive: true });
  const artifact = { kind: 'screen', redaction: 'complete', path: 'raw/artifacts/case/screen.txt' };
  const report = { cases: [{ id: 'TC-1', attempts: [{ artifacts: [artifact] }] }] } as unknown as QAReport;
  const selection = { caseId: 'TC-1', attempt: 0, artifact: 0 };
  const denied = async () => assert.rejects(readEvidence(run, report, selection), (error: unknown) => error instanceof EvidenceError && error.status === 404 && !error.message.includes(root));
  try {
    await writeFile(path.join(run, artifact.path), '<script>untrusted</script> 한글');
    const result = await readEvidence(run, report, selection);
    assert.equal(result.contentType, 'text/plain; charset=utf-8');
    assert.equal(result.body.toString(), '<script>untrusted</script> 한글');
    assert.equal(result.filename, 'TC-1-attempt-1-evidence-1.txt');
    artifact.redaction = 'incomplete'; await denied(); artifact.redaction = 'not-required';
    for (const unsafe of ['../outside.txt', 'raw/artifacts/../secret.txt', 'raw/artifacts/.secret.txt', 'raw/artifacts//x.txt', 'raw/artifacts/a\\b.txt', 'raw/artifacts/x.txt?secret', 'raw/artifacts/x.html', 'raw/artifacts/x.svg']) {
      artifact.path = unsafe; await denied();
    }
    await writeFile(path.join(root, 'secret.txt'), 'secret');
    await symlink(path.join(root, 'secret.txt'), path.join(run, 'raw/artifacts/link.txt'));
    artifact.path = 'raw/artifacts/link.txt'; await denied();
    await symlink(root, path.join(run, 'raw/artifacts/linked-directory'));
    artifact.path = 'raw/artifacts/linked-directory/secret.txt'; await denied();
    artifact.path = 'raw/artifacts/case'; await denied();
    artifact.path = 'raw/artifacts/case/image.png';
    await writeFile(path.join(run, artifact.path), '<html>wrong type</html>'); await denied();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jAZkAAAAASUVORK5CYII=', 'base64');
    await writeFile(path.join(run, artifact.path), png);
    assert.deepEqual((await readEvidence(run, report, selection)).body, png);
    artifact.path = 'raw/artifacts/case/large.txt';
    await writeFile(path.join(run, artifact.path), Buffer.alloc(10 * 1024 * 1024 + 1));
    await assert.rejects(readEvidence(run, report, selection), (error: unknown) => error instanceof EvidenceError && error.status === 413);
    await assert.rejects(readEvidence(run, report, { ...selection, artifact: 9 }), EvidenceError);
    await assert.rejects(readEvidence(run, report, { ...selection, attempt: -1 }), EvidenceError);
    await assert.rejects(readEvidence(run, report, { ...selection, caseId: 'other' }), EvidenceError);
  } finally { await rm(root, { recursive: true, force: true }); }
});
