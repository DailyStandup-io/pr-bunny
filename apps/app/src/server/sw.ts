// The service worker, served at /sw.js. It only exists to handle clicks on desktop notifications:
// focus an open PR Bunny tab and tell it what to open, or open a new tab if none is left. No fetch
// handler, no caching, no push: everything comes from the local server while a tab is open.
export const SERVICE_WORKER = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const tab = tabs.find((c) => c.focused) || tabs[0];
    if (tab) {
      await tab.focus();
      tab.postMessage({ type: "pb:open", id: data.id ?? null, href: data.href ?? null });
      return;
    }
    const url = data.id ? "/?open=" + encodeURIComponent(data.id) : data.href && data.href.startsWith("/") ? data.href : "/";
    await self.clients.openWindow(url);
  })());
});
`;
