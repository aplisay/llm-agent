// A throwaway certificate authority for the provisioning tests, made with the
// openssl command. It stands in for a phone vendor's CA: a root, an
// intermediate under it, and phone certificates with a MAC as common name.
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = (dir, args) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });

const KEY = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];

export function makeTestCa(name = 'Test Phone') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-test-ca-'));
  const read = (file) => fs.readFileSync(path.join(dir, file), 'utf8');
  let serial = 1;
  fs.writeFileSync(path.join(dir, 'ca.cnf'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  fs.writeFileSync(path.join(dir, 'leaf.cnf'), 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');

  run(dir, ['req', '-x509', ...KEY, '-keyout', 'root.key', '-out', 'root.crt', '-subj', `/O=${name}/CN=${name} Root CA`,
    '-days', '3650', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run(dir, ['req', ...KEY, '-keyout', 'int.key', '-out', 'int.csr', '-subj', `/O=${name}/CN=${name} 1`]);
  run(dir, ['x509', '-req', '-in', 'int.csr', '-CA', 'root.crt', '-CAkey', 'root.key', '-set_serial', String(serial += 1),
    '-out', 'int.crt', '-days', '3650', '-extfile', 'ca.cnf']);

  /** A certificate under the intermediate. `commonName` is the MAC for a phone. */
  const issue = (commonName) => {
    const id = `leaf${serial += 1}`;
    run(dir, ['req', ...KEY, '-keyout', `${id}.key`, '-out', `${id}.csr`, '-subj', `/O=${name}/CN=${commonName}`]);
    run(dir, ['x509', '-req', '-in', `${id}.csr`, '-CA', 'int.crt', '-CAkey', 'int.key', '-set_serial', String(serial),
      '-out', `${id}.crt`, '-days', '3650', '-extfile', 'leaf.cnf']);
    const pem = read(`${id}.crt`);
    return { pem, key: read(`${id}.key`), certificate: new X509Certificate(pem) };
  };

  const rootPem = read('root.crt');
  const intermediatePem = read('int.crt');
  const root = new X509Certificate(rootPem);
  return {
    rootPem,
    intermediatePem,
    bundlePem: `${rootPem}\n${intermediatePem}`,
    root,
    intermediate: new X509Certificate(intermediatePem),
    fingerprint: root.fingerprint256,
    issue,
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
