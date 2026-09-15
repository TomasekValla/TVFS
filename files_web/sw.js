// TVFS Service Worker — Share Target + minimal caching
// Version: 1.0.0

const IDB_NAME    = 'tvfs-share';
const IDB_STORE   = 'pending-files';
const IDB_VERSION = 1;

// ─── Lifecycle ────────────────────────────────────────────────────────────────

self.addEventListener('install', function(e) {
    // Activate immediately — no old SW to wait for
    self.skipWaiting();
});

self.addEventListener('activate', function(e) {
    // Take control of all clients (tabs) right away
    e.waitUntil(clients.claim());
});

// ─── Fetch handler — intercept share-target POST ─────────────────────────────

self.addEventListener('fetch', function(event) {
    var url = new URL(event.request.url);

    if (url.pathname === '/share-target' && event.request.method === 'POST') {
        event.respondWith(handleShareTarget(event.request));
        return;
    }

    // Everything else: go straight to network (no caching, keep things simple)
    // event.respondWith(fetch(event.request));  // <- uncomment for explicit passthrough
});

async function handleShareTarget(request) {
    try {
        var formData = await request.formData();

        // Collect all shared files (field name matches manifest params.files[].name)
        var files = formData.getAll('files');

        if (files && files.length > 0) {
            await storeFilesInIDB(files);
        }
    } catch (err) {
        console.error('[TVFS SW] Share target error:', err);
    }

    // Redirect to the upload page — the page will pick up files from IDB
    return Response.redirect('/upload.html?share=1', 303);
}

// ─── IDB helpers ──────────────────────────────────────────────────────────────

function openIDB() {
    return new Promise(function(resolve, reject) {
        var req = indexedDB.open(IDB_NAME, IDB_VERSION);

        req.onupgradeneeded = function(e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { autoIncrement: true });
            }
        };

        req.onsuccess  = function(e) { resolve(e.target.result); };
        req.onerror    = function()  { reject(req.error); };
        req.onblocked  = function()  { reject(new Error('IDB blocked')); };
    });
}

async function storeFilesInIDB(files) {
    var db = await openIDB();
    return new Promise(function(resolve, reject) {
        var tx    = db.transaction(IDB_STORE, 'readwrite');
        var store = tx.objectStore(IDB_STORE);

        // Clear any leftover files from a previous share that wasn't consumed
        store.clear();

        for (var i = 0; i < files.length; i++) {
            store.add(files[i]);
        }

        tx.oncomplete = function() { db.close(); resolve(); };
        tx.onerror    = function() { db.close(); reject(tx.error); };
    });
}
