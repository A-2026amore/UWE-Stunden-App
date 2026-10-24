const CACHE='uwe-stunden-v3-pdf-20261024';
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['./','./index.html','./test-mitarbeiter.html','./uwe-pdf.js','./uwe-config.js','./manifest.json','./icon.svg']))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;event.respondWith(fetch(event.request).then(response=>{if(response.ok&&new URL(event.request.url).origin===self.location.origin){const c=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,c)).catch(()=>{})}return response}).catch(()=>caches.match(event.request)))});
