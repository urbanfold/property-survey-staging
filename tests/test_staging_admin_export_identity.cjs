// Staging-only static guard: export UI follows the same authenticated subject as admin review.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const app = fs.readFileSync('app.js', 'utf8');
assert.match(app, /const STAGING_EXPORT_ADMIN_UID = '[0-9a-f-]{36}';/);
assert.match(app, /const isStagingExportAdmin = \(\) => currentUser\?\.id === STAGING_EXPORT_ADMIN_UID;/);
assert.match(app, /if \(!isStagingExportAdmin\(\)\) query = query\.eq\('user_id', currentUser\.id\);/);
assert.match(app, /if \(isStagingExportAdmin\(\)\) \{[\s\S]*?Download Survey Pack \(ZIP\)/);
assert.match(app, /isStagingExportAdmin\(\) \? 'block' : 'none';/);
assert.match(app, /const ADMIN_EMAIL = 'urbanfolduk@gmail.com';/); // Remaining launch rules unchanged.
console.log('PASS staging export controls use verified admin UID; nonadmins keep owned-survey filter');
