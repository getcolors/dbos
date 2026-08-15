import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { deterministicResult, WorkflowResult } from './result.js';

const databaseUrl = required('DBOS_SYSTEM_DATABASE_URL');
const defaultDelay = positiveInt(process.env.DBOS_DURABLE_DELAY_SECONDS ?? '60', 'DBOS_DURABLE_DELAY_SECONDS');
const maxAttempts = positiveInt(process.env.DBOS_STEP_MAX_ATTEMPTS ?? '3', 'DBOS_STEP_MAX_ATTEMPTS');
const retrySeconds = positiveInt(process.env.DBOS_STEP_INITIAL_RETRY_SECONDS ?? '1', 'DBOS_STEP_INITIAL_RETRY_SECONDS');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });

DBOS.setConfig({
  name: process.env.DBOS_APPLICATION_NAME ?? 'dbos-reference',
  applicationVersion: process.env.DBOS_APPLICATION_VERSION ?? '4.25.14',
  systemDatabaseUrl: databaseUrl,
  systemDatabasePoolSize: positiveInt(process.env.DBOS_SYSTEM_DATABASE_POOL_SIZE ?? '10', 'DBOS_SYSTEM_DATABASE_POOL_SIZE'),
  runAdminServer: false,
});

async function retryableActivity(workflowID: string): Promise<number> {
  const { rows } = await pool.query<{ attempts: number }>(
    `INSERT INTO activity_attempts (workflow_id, attempts)
     VALUES ($1, 1)
     ON CONFLICT (workflow_id) DO UPDATE SET attempts = activity_attempts.attempts + 1
     RETURNING attempts`,
    [workflowID],
  );
  const attempts = rows[0].attempts;
  console.log(JSON.stringify({ event: 'activity-attempt', workflowID, attempts }));
  if (attempts < 2) throw new Error('intentional first activity failure');
  return attempts;
}

const activity = DBOS.registerStep(retryableActivity, {
  name: 'retryableActivity', retriesAllowed: true, maxAttempts,
  intervalSeconds: retrySeconds, backoffRate: 1,
});

async function referenceWorkflow(workflowID: string, input: string, delaySeconds: number): Promise<WorkflowResult> {
  await DBOS.sleep(delaySeconds * 1000);
  const attempts = await activity(workflowID);
  return deterministicResult(workflowID, input, attempts);
}
const workflow = DBOS.registerWorkflow(referenceWorkflow, { name: 'referenceWorkflow', maxRecoveryAttempts: 10 });

await pool.query(`CREATE TABLE IF NOT EXISTS activity_attempts (
  workflow_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL CHECK (attempts > 0)
)`);
await DBOS.launch();

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/up') return json(res, 200, { status: 'ok' });
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok', dbos: 'launched' });
    if (req.method === 'POST' && req.url === '/workflows') {
      const body = await readJson(req);
      const workflowID = stringField(body, 'workflowID');
      const input = stringField(body, 'input');
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workflowID)) return json(res, 400, { error: 'invalid workflowID' });
      const delaySeconds = body.delaySeconds === undefined ? defaultDelay : positiveInt(body.delaySeconds, 'delaySeconds');
      if (delaySeconds > 86400) return json(res, 400, { error: 'delaySeconds must not exceed 86400' });
      const existing = await DBOS.getWorkflowStatus(workflowID);
      await DBOS.startWorkflow(workflow, { workflowID })(workflowID, input, delaySeconds);
      return json(res, existing ? 200 : 202, { workflowID, duplicate: existing !== null, statusURL: `/workflows/${encodeURIComponent(workflowID)}` });
    }
    const match = req.method === 'GET' ? req.url?.match(/^\/workflows\/([A-Za-z0-9._:%-]+)$/) : null;
    if (match) {
      const workflowID = decodeURIComponent(match[1]);
      const status = await DBOS.getWorkflowStatus(workflowID);
      if (!status) return json(res, 404, { error: 'workflow not found' });
      const { rows } = await pool.query<{ attempts: number }>('SELECT attempts FROM activity_attempts WHERE workflow_id=$1', [workflowID]);
      let result: WorkflowResult | null = null;
      if (status.status === 'SUCCESS') result = await DBOS.retrieveWorkflow<WorkflowResult>(workflowID).getResult();
      return json(res, 200, { workflowID, status: status.status, activityAttempts: rows[0]?.attempts ?? 0, result });
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    console.error(error);
    return json(res, error instanceof SyntaxError ? 400 : 500, { error: error instanceof Error ? error.message : String(error) });
  }
});
server.listen(80, '0.0.0.0', () => console.log('DBOS reference API listening on :80'));

async function shutdown(signal: string) {
  console.log(`received ${signal}`);
  server.close();
  await DBOS.shutdown();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function positiveInt(value: unknown, name: string): number { const n = Number(value); if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`); return n; }
function stringField(body: Record<string, unknown>, name: string): string { const value = body[name]; if (typeof value !== 'string' || value.length === 0 || value.length > 1024) throw new SyntaxError(`${name} must be a non-empty string`); return value; }
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of req) { chunks.push(Buffer.from(chunk)); if (chunks.reduce((n, b) => n + b.length, 0) > 16384) throw new SyntaxError('request too large'); } const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('JSON object required'); return parsed as Record<string, unknown>; }
function json(res: ServerResponse, status: number, body: unknown) { const payload = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' }); res.end(payload); }
