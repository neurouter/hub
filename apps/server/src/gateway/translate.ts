import { hkdf } from '../lib/crypto.js';
import { open, seal } from '../secrets/envelope.js';
import type { Keyring } from '../secrets/keyring.js';

/** What a wrapped MRTR `requestState` binds (backend §5.6 step 7). */
export interface WrappedState {
  /** upstream state, verbatim */
  s: string;
  srv: string;
  tool: string;
  uid: string;
  aid: string;
  /** expiry, epoch ms */
  exp: number;
}

const AAD = 'neurouter:mrtr:v1';
const keyFor = (keyring: Keyring, kekId: string) => hkdf(keyring.derivationKey(kekId), 'neurouter:mrtr');

/**
 * `v1.<kekId>.<base64url(nonce‖ciphertext)>`: AES-GCM under HKDF(KEK, 'mrtr'), so a client can
 * neither read the upstream state nor replay it to another server, tool, user or agent.
 */
export function wrapRequestState(keyring: Keyring, state: WrappedState): string {
  const kekId = keyring.activeKekId;
  const sealed = seal(keyFor(keyring, kekId), Buffer.from(JSON.stringify(state)), AAD);
  return `v1.${kekId}.${Buffer.concat([sealed.nonce, sealed.ciphertext]).toString('base64url')}`;
}

export class RequestStateError extends Error {
  constructor(reason: string) {
    super(`Invalid requestState: ${reason}`);
    this.name = 'RequestStateError';
  }
}

export function unwrapRequestState(keyring: Keyring, token: string, expect: { uid: string; aid: string; now: number; srv?: string; tool?: string }): WrappedState {
  const m = /^v1\.([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m || !keyring.has(m[1]!)) throw new RequestStateError('malformed');
  const raw = Buffer.from(m[2]!, 'base64url');
  let st: WrappedState;
  try {
    st = JSON.parse(open(keyFor(keyring, m[1]!), { nonce: raw.subarray(0, 12), ciphertext: raw.subarray(12) }, AAD).toString('utf8')) as WrappedState;
  } catch {
    throw new RequestStateError('tampered or foreign');
  }
  if (st.uid !== expect.uid || st.aid !== expect.aid) throw new RequestStateError('bound to another principal');
  if (st.exp <= expect.now) throw new RequestStateError('expired');
  if (expect.srv !== undefined && st.srv !== expect.srv) throw new RequestStateError('bound to another server');
  if (expect.tool !== undefined && st.tool !== expect.tool) throw new RequestStateError('bound to another tool');
  return st;
}
