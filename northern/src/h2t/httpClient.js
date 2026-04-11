'use strict';

import http from 'node:http';

export default class HttpClient {

    execute (options, cb){

        var reqGet = http.request(options, function(res) {
            res.on('data', function(d) {
                var data = JSON.parse( d.toString() );
                cb(null, data);
            });
        
        });
        
        reqGet.end();
        reqGet.on('error', function(e) {
            cb(e,null);
        });

    }
}
