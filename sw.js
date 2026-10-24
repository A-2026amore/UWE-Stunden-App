const CACHE='uwe-stunden-v17-chef-device-install-20261024';
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['./','./index.html','./test-mitarbeiter.html','./uwe-pdf.js?v=8','./uwe-logo.svg','./uwe-fluegel.svg','./chef-mobil.html','./chef-staff.js?v=17','./chef-mobil.js?v=17','./uwe-access-check.js?v=16','./chef-manifest.json','./chef-pwa.json','./chef-icon.svg','./uwe-config.js','./manifest.json','./icon.svg','./icon-192.png','./icon-512.png','./apple-touch-icon.png'])).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;
const requestURL=new URL(event.request.url);
if(requestURL.origin===self.location.origin&&requestURL.pathname.endsWith('/uwe-access-control.json')){
  // Never cache or serve a stale central employee revocation list.
  event.respondWith(fetch(event.request,{cache:'no-store'}));
  return;
}
event.respondWith(fetch(event.request).then(response=>{if(response.ok&&new URL(event.request.url).origin===self.location.origin){const c=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,c)).catch(()=>{})}return response}).catch(()=>caches.match(event.request)))});
