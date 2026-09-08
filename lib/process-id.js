/**
 * Identity of THIS server process, for state that one process holds in memory
 * on behalf of others (today: interactive chat sessions, `chat_sessions.owner`).
 *
 * The name is for humans reading a row: the pod name where Kubernetes sets one
 * (POD_NAME via the downward API, else HOSTNAME, which Kubernetes also sets to
 * the pod name), else the machine's hostname. The pid and the random suffix are
 * what make it unique: a pod that restarts keeps its name, and a process must
 * never mistake the previous incarnation's rows for its own.
 */
import os from 'node:os';
import { randomBytes } from 'node:crypto';

const name = process.env.POD_NAME || process.env.HOSTNAME || os.hostname();

export const PROCESS_ID = `${name}:${process.pid}:${randomBytes(4).toString('hex')}`;

export default PROCESS_ID;
