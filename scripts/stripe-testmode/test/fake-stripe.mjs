#!/usr/bin/env node
// A FAKE `stripe` executable for unit tests: records every call and answers from a JSON state file. Never talks to the network.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
const D = process.env.FAKE_DIR; const args = process.argv.slice(2);
appendFileSync(`${D}/calls.log`, JSON.stringify({ args, stateFileExisted: process.env.FAKE_STATE ? existsSync(process.env.FAKE_STATE) : null }) + '\n');
const st = JSON.parse(readFileSync(`${D}/endpoints.json`, 'utf8'));
const method = args[0], path = args[1], data = []; for (let i = 0; i < args.length; i++) if (args[i] === '-d') data.push(args[i + 1]);
if (!args.includes('--project-name') || args[args.indexOf('--project-name') + 1] !== 'default') { console.log('{"error":{"message":"fake: missing project"}}'); process.exit(1); }
if (process.env.STRIPE_API_KEY) { console.log('{"error":{"message":"fake: STRIPE_API_KEY leaked into the CLI environment"}}'); process.exit(1); }
const fail = (status, msg) => { process.stdout.write(`Request failed, status=${status}, body={"error":{"type":"invalid_request_error","message":${JSON.stringify(msg)}}}\n`); process.exit(1); };
if (method === 'get' && path === '/v1/webhook_endpoints') { console.log(JSON.stringify({ object: 'list', has_more: false, data: st.v1.map((e) => ({ ...e, livemode: process.env.FAKE_LIVEMODE === '1' })) })); process.exit(0); }
if (method === 'get' && path === '/v2/core/event_destinations') { if (process.env.FAKE_V2_FAIL) fail(404, 'v2 not available'); console.log(JSON.stringify({ data: st.v2 ?? [] })); process.exit(0); }
if (method === 'get' && path === '/v1/charges') { if (process.env.FAKE_ERR_EXIT0) { console.log(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing', message: 'A test clock can have at most 3 customers' } })); process.exit(0); } if (process.env.FAKE_WARN) console.log('[WARN] your CLI uses API version {x} which is outdated [see docs]'); console.log(JSON.stringify({ object: 'list', data: [{ id: 'ch_1' }], has_more: false })); process.exit(0); }
let m = /^\/v1\/webhook_endpoints\/(we_\w+)$/.exec(path);
if (method === 'post' && m) {
  const e = st.v1.find((x) => x.id === m[1]); if (!e) fail(404, 'No such webhook endpoint');
  const n = (st.posts = (st.posts ?? 0) + 1); if (process.env.FAKE_CRASH_AFTER_POSTS && n > Number(process.env.FAKE_CRASH_AFTER_POSTS)) { process.exit(137); }
  if (process.env.FAKE_FAIL_POST === m[1]) fail(500, 'boom');
  if (data.includes('disabled=true')) e.status = 'disabled'; else if (data.includes('disabled=false')) e.status = 'enabled'; else fail(400, 'bad data');
  if (process.env.FAKE_CORRUPT_ON_ENABLE && data.includes('disabled=false')) e.enabled_events = ['*'];
  writeFileSync(`${D}/endpoints.json`, JSON.stringify(st)); console.log(JSON.stringify({ ...e, livemode: false })); process.exit(0);
}
fail(400, `fake stripe: unexpected call ${args.join(' ')}`);
