console.log('Loaded service worker!');

self.addEventListener('install', function(event) {
    event.waitUntil(self.skipWaiting());
  });
  
  self.addEventListener('activate', function(event) {
    event.waitUntil(self.clients.claim());
  });

self.addEventListener('push', event => {
  const data = event.data.json();
  console.log('Got push', data);
  event.waitUntil(
    self.registration.showNotification(data.title, {
        body: 'New OpenChannel Msg',
        icon: 'open.png',
        vibrate: [200, 100, 200, 100, 200, 100, 400],
        tag: 'request',
    })
  );
});

self.addEventListener('notificationclick', event => {
    // let url = "https://gazers.info/OpenChannel/view.html";
    let url = "/fs/get/OpenChannel/view.html";

    // event.notification.close(); // Android needs explicit close.
    event.waitUntil(
        clients.matchAll({type: 'window'}).then( windowClients => {
            console.log(JSON.stringify(windowClients));
            // Check if there is already a window/tab open with the target URL
            for (var i = 0; i < windowClients.length; i++) {
                var client = windowClients[i];
                // If so, just focus it.
                if (client.url === url && 'focus' in client) {
                    return client.focus();
                }
            }
            // If not, then open the target URL in a new window/tab.
            if (clients.openWindow) {
                return clients.openWindow(url);
            }
        })
    );
});