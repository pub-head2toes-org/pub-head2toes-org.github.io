'use strict';

import http from 'node:http';

export default class HttpClient {

    execute (options, cb){

        var reqGet = http.request(options, function(res) {
            var body = '';
            res.setEncoding('utf8');
            res.on('data', function(d) {
                body += d;
            });
            res.on('end', function() {
                // Parsing here rather than per chunk: a response split over
                // several chunks is not valid JSON on its own, and a throw in
                // the data listener has nowhere to go but the process.
                try {
                    cb(null, JSON.parse(body));
                } catch (err) {
                    cb(err, null);
                }
            });
            res.on('error', function(e) {
                cb(e, null);
            });
        });

        reqGet.end();
        reqGet.on('error', function(e) {
            cb(e,null);
        });

    }
}
