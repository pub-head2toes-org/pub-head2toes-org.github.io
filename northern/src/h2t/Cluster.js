//'use strict';

import Server from "./Server.js"

// Callbacks handed to sqlite3 run outside every try/catch on the request path,
// so a throw in one of them would otherwise take the whole node down with it.
// The request that caused it is already lost; the rest of the node survives.
process.on('uncaughtException', function (err) {
    console.log('uncaughtException::', err);
});
process.on('unhandledRejection', function (err) {
    console.log('unhandledRejection::', err);
});

var server0 = new Server (9090,'../../../abcd.db');
// var server1 = new Server (9091,'../../../abcd1.db');
// var server2 = new Server (9092,'../../../abcd2.db');

