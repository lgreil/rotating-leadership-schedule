// Service worker: makes the page installable and shows push notifications.
// Data is always loaded live, so nothing is cached here.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {}); // network only

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Team Lead" };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const open = clients.find((c) => new URL(c.url).pathname === "/");
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
