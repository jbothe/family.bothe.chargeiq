'use strict';

import test from 'node:test';
import assert from 'node:assert';
import path from 'path';
// Importing CentralSystem is the point: it calls installLeanValidators() at
// module load, before its own require('ocpp-rpc'). This file therefore exercises
// the real production ordering rather than re-deriving it.
import { CentralSystem } from '../lib/ocpp/CentralSystem';
import { OCPP_SUBPROTOCOL, installLeanValidators } from '../lib/ocpp/leanValidators';

interface StandardValidator {
  subprotocol: string;
  validate(schemaId: string, params: unknown): boolean;
}

// ocpp-rpc's internals are untyped CommonJS; this is the list the fix rewrites.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const standardValidators: StandardValidator[] = require('ocpp-rpc/lib/standard-validators');

// node --test runs each test file in its own process, so this file sees a clean
// module cache and these assertions are about what the app itself would load.

test('only the ocpp1.6 validator is built - the 2.x ones cost ~20MB RSS unused', () => {
  assert.deepEqual(standardValidators.map((v) => v.subprotocol), [OCPP_SUBPROTOCOL]);
});

test('the unused OCPP 2.x schemas are never loaded at all', () => {
  // The saving is the schema JSON never being parsed, not merely an unused
  // validator being discarded - assert on the module cache, not the list above.
  const loaded = Object.keys(require.cache)
    .filter((id) => id.includes(`ocpp-rpc${path.sep}lib`) && id.endsWith('.json'));
  assert.deepEqual(loaded.map((id) => path.basename(id)), ['ocpp1_6.json']);
});

test('full ocpp1.6 schema validation still works', () => {
  const [v] = standardValidators;
  assert.equal(v.validate('urn:Authorize.req', { idTag: 'CHARGEIQ' }), true);
  assert.equal(
    v.validate('urn:StatusNotification.req', { connectorId: 1, errorCode: 'NoError', status: 'Charging' }),
    true,
  );
});

test('ocpp1.6 validation still rejects a bad payload', () => {
  const [v] = standardValidators;
  // idTag is required by Authorize.req.
  assert.throws(() => v.validate('urn:Authorize.req', {}));
  // Status is a closed enum.
  assert.throws(() => v.validate(
    'urn:StatusNotification.req',
    { connectorId: 1, errorCode: 'NoError', status: 'NotAStatus' },
  ));
});

test('an ocpp-rpc RPCServer still constructs in strictMode', async () => {
  const cs = new CentralSystem({
    port: 9934,
    authorize: () => true,
    allocateTransactionId: () => 1,
    logger: () => { /* quiet */ },
  });
  // start() is what actually builds the strictMode RPCServer; a missing
  // ocpp1.6 validator would throw here rather than degrade silently.
  await cs.start();
  await cs.stop();
});

test('installLeanValidators is a no-op once ocpp-rpc has already been loaded', () => {
  // It cannot help after the fact, and must not swap the list out from under
  // whoever loaded it first.
  assert.equal(installLeanValidators(), false);
  assert.deepEqual(standardValidators.map((v) => v.subprotocol), [OCPP_SUBPROTOCOL]);
});
