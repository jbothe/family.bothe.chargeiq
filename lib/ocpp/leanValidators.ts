'use strict';

/**
 * ocpp-rpc's `lib/standard-validators` module builds an Ajv-backed validator
 * for *every* OCPP subprotocol it knows about - ocpp1.6, ocpp2.0.1 and ocpp2.1
 * - at require time, unconditionally, from the top of `lib/server.js`. There is
 * no option to narrow it: `RPCServer`'s `strictModeValidators` only *adds* to
 * the standard list.
 *
 * This app negotiates ocpp1.6 and nothing else (see CentralSystem's `protocols`),
 * so the other two are ~1.5MB of schema JSON parsed into retained object graphs
 * plus two spare Ajv instances, held for the app's whole lifetime. Measured on
 * the real module (loading ocpp-rpc + homey-api and constructing the strictMode
 * RPCServer, three runs, stable to +/-0.6MB):
 *
 *     as shipped        93.3 MB RSS   13.74 MB heapUsed
 *     1.6-only          73.4 MB RSS   11.70 MB heapUsed
 *
 * i.e. ~20MB RSS / ~2MB heap for schemas that can never be reached. That is the
 * single largest line item in this app's footprint, and Homey reports RSS.
 *
 * Seeding the module cache is the only lever, since the offending require runs
 * before any option we could pass. Full ocpp1.6 schema validation is untouched -
 * the same `createValidator` on the same schema file, just without its two
 * unused siblings.
 *
 * Going further is not possible: with an empty validator list `RPCServer`
 * throws `Missing strictMode validator for subprotocol 'ocpp1.6'`, so dropping
 * Ajv entirely would mean hand-rolling OCPP validation.
 */

/**
 * The one OCPP subprotocol this app speaks. Lives here rather than in
 * CentralSystem because the two uses are the same decision: it is what the
 * RPCServer advertises *and* the only validator installLeanValidators() keeps.
 * Advertising a protocol whose validator was dropped is exactly the mismatch
 * that makes RPCServer throw at start(), so they must not drift apart.
 */
export const OCPP_SUBPROTOCOL = 'ocpp1.6';

/**
 * Replace ocpp-rpc's standard validator list with an ocpp1.6-only one, before
 * anything requires ocpp-rpc itself.
 *
 * Must run *before* the first `require('ocpp-rpc')` in the process - by then
 * `standard-validators` has already been evaluated and the 2.x schemas are
 * loaded, so there is nothing left to save. Returns whether it took effect;
 * `test/lean-validators.test.ts` asserts it did, so an ocpp-rpc upgrade that
 * moves these internal paths fails loudly in CI rather than silently giving the
 * saving back.
 *
 * Reaching into a dependency's internal file layout is deliberate but hedged:
 * every failure mode here is a no-op that leaves ocpp-rpc to load normally.
 */
export function installLeanValidators(): boolean {
  try {
    // Every require here is deliberately inline rather than a top-level import:
    // this function's whole purpose is to control *when* ocpp-rpc's internals
    // are pulled in relative to ocpp-rpc itself, which a hoisted import would
    // defeat. (They are also untyped CommonJS internals, hence no-var-requires.)
    /* eslint-disable global-require, @typescript-eslint/no-var-requires */
    const path = require('path');
    const id = require.resolve('ocpp-rpc/lib/standard-validators');
    // Already evaluated - too late for this to help, and overwriting the cache
    // now would hand a different validator list to whoever loaded it first.
    if (require.cache[id]) return false;
    const { createValidator } = require('ocpp-rpc/lib/validator');
    const schema = require('ocpp-rpc/lib/schemas/ocpp1_6.json');
    /* eslint-enable global-require, @typescript-eslint/no-var-requires */
    require.cache[id] = {
      id,
      filename: id,
      path: path.dirname(id),
      loaded: true,
      exports: [createValidator(OCPP_SUBPROTOCOL, schema)],
      children: [],
      paths: [],
    } as unknown as NodeModule;
    return true;
  } catch {
    // Layout moved, or ocpp-rpc isn't resolvable from here. Leave it alone.
    return false;
  }
}
