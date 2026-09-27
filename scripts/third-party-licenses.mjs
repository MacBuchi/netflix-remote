// Writes THIRD_PARTY_LICENSES.txt into the given build folders: the license texts of all runtime
// dependencies (package.json "dependencies" and everything they pull in), as their licenses require.
// Usage: node scripts/third-party-licenses.mjs extension/dist remote/dist
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const targets = process.argv.slice(2);
if (!targets.length) throw new Error('usage: third-party-licenses.mjs <folder>...');

/** Node's lookup: the package's own node_modules first, then the parents'. */
function findPackage(name, fromDir) {
    for (let dir = fromDir; ; dir = dirname(dir)) {
        const candidate = join(dir, 'node_modules', name);
        if (existsSync(join(candidate, 'package.json'))) return candidate;
        if (dir === ROOT || dir === dirname(dir)) return null;
    }
}

const seen = new Map();
function collect(name, fromDir) {
    const dir = findPackage(name, fromDir);
    if (!dir || seen.has(dir)) return;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    seen.set(dir, {
        name: pkg.name,
        version: pkg.version,
        license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'siehe Paket'),
        text: file ? readFileSync(join(dir, file), 'utf8').trim() : null,
    });
    for (const dep of Object.keys(pkg.dependencies ?? {})) collect(dep, dir);
}

const own = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
for (const dep of Object.keys(own.dependencies)) collect(dep, ROOT);

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const text = [
    'Couch Remote includes the following third-party software.',
    '',
    ...entries.map((e) =>
        [`${'='.repeat(72)}`, `${e.name} ${e.version} (${e.license})`, `${'='.repeat(72)}`, e.text ?? '(no license file shipped with the package)', ''].join('\n'),
    ),
].join('\n');

for (const target of targets) {
    writeFileSync(join(ROOT, target, 'THIRD_PARTY_LICENSES.txt'), text);
    console.log(`wrote ${target}/THIRD_PARTY_LICENSES.txt (${entries.length} packages)`);
}
