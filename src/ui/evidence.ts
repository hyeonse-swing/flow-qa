import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { QAReport } from '../report.ts';

const MAX_EVIDENCE = 10 * 1024 * 1024;
export class EvidenceError extends Error {
  readonly status: number;
  constructor(status = 404) {
    super(status === 413 ? 'Evidence files must be 10 MiB or smaller.' : 'No readable evidence file was found.');
    this.status = status;
  }
}

/** Only a report-selected, redaction-approved artifact can leave its run directory. */
export async function readEvidence(runDir: string, report: QAReport, selection: { caseId: string; attempt: number; artifact: number }): Promise<{
  body: Buffer; contentType: string; filename: string; preview: 'image' | 'text';
}> {
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(selection.caseId) ||
      !Number.isInteger(selection.attempt) || selection.attempt < 0 || !Number.isInteger(selection.artifact) || selection.artifact < 0) throw new EvidenceError();
    const testCase = Array.isArray(report.cases) ? report.cases.find((item) => item?.id === selection.caseId) : undefined;
    const attempt = Array.isArray(testCase?.attempts) ? testCase.attempts[selection.attempt] : undefined;
    const artifact = Array.isArray(attempt?.artifacts) ? attempt.artifacts[selection.artifact] : undefined;
    if (!artifact || !['complete', 'not-required'].includes(artifact.redaction) || typeof artifact.path !== 'string') throw new EvidenceError();
    const relative = artifact.path;
    if (!relative.startsWith('raw/artifacts/') || /[\\\x00-\x1f\x7f?#]/.test(relative)) throw new EvidenceError();
    const parts = relative.split('/');
    if (parts.some((part) => !part || part.startsWith('.'))) throw new EvidenceError();
    const extension = path.extname(relative).toLowerCase();
    const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8' };
    const contentType = types[extension];
    if (!contentType) throw new EvidenceError();
    const rootInfo = await lstat(runDir);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new EvidenceError();
    const root = await realpath(runDir);
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]!);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile()) || await realpath(current) !== current) throw new EvidenceError();
    }
    const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    let body: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new EvidenceError();
      if (info.size > MAX_EVIDENCE) throw new EvidenceError(413);
      // Bounded reads also cover a file growing after stat.
      body = Buffer.alloc(Math.min(info.size + 1, MAX_EVIDENCE + 1));
      let offset = 0;
      while (offset < body.length) {
        const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > MAX_EVIDENCE || offset > info.size) throw new EvidenceError(413);
      body = body.subarray(0, offset);
    } finally { await handle.close(); }
    const image = contentType.startsWith('image/');
    if (contentType === 'image/png' && !body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new EvidenceError();
    if (contentType === 'image/jpeg' && !body.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) throw new EvidenceError();
    if (contentType === 'image/webp' && (body.toString('ascii', 0, 4) !== 'RIFF' || body.toString('ascii', 8, 12) !== 'WEBP')) throw new EvidenceError();
    if (!image) new TextDecoder('utf-8', { fatal: true }).decode(body);
    return { body, contentType, filename: `${selection.caseId}-attempt-${selection.attempt + 1}-evidence-${selection.artifact + 1}${extension}`, preview: image ? 'image' : 'text' };
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError();
  }
}
