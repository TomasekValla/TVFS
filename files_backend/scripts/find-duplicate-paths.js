'use strict';

// Read-only report: lists registry entries that share the same `path`.
// Such groups were created by the old overwrite-on-collision behaviour.
// Deletes nothing; the unlink guards in upload.js/cleanup.js keep the shared
// file on disk until the last entry pointing at it expires.
//
// Usage: node scripts/find-duplicate-paths.js [path/to/file_registry.json]

const fs = require('fs');
const path = require('path');

const registryPath = process.argv[2] || path.join(__dirname, '../../files_web/file_registry.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const files = Array.isArray(registry.files) ? registry.files : [];

const byPath = new Map();
for (const f of files) {
    if (!f.path) continue;
    if (!byPath.has(f.path)) byPath.set(f.path, []);
    byPath.get(f.path).push(f);
}

const groups = [...byPath.entries()].filter(([, entries]) => entries.length > 1);

console.log(`Registry: ${registryPath}`);
console.log(`${files.length} entries, ${groups.length} shared path(s)\n`);

for (const [p, entries] of groups) {
    console.log(`${p}  (${entries.length} entries, ${fs.existsSync(p) ? 'on disk' : 'missing on disk'})`);
    for (const f of entries) {
        const uploaded = f.uploadedAt ? new Date(f.uploadedAt).toISOString() : '?';
        const expires = typeof f.expiresAt === 'number' ? new Date(f.expiresAt).toISOString() : '?';
        console.log(`  ${f.id}  ${f.originalName || f.storedName || ''}  uploaded ${uploaded}  expires ${expires}`);
    }
}
