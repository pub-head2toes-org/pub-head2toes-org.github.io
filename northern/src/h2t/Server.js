'use strict';

import http from 'node:http';
import https from 'node:https';
import url from 'node:url';
import Render from './Render.js';
const render = new Render();
import Crypto from './Crypto.js';
const crypto = new Crypto();
import Cookie from './Cookie.js';
const cookie = new Cookie();
import fs from 'node:fs';
import SqliteDB from './SqliteDBWithReplicas.js';
const sub = {};

export default class Server{
    constructor(port, dbFilePath) {
        this.init(port, dbFilePath, cookie.getCookie);
    }

    init(port, dbFilePath, getCookie){
        console.log('init::'+port);
        const db = new SqliteDB (dbFilePath);

        const privateKey = fs.readFileSync('server.key').toString();
        const certificate = fs.readFileSync('server.crt').toString();

        const options = { key: privateKey, cert: certificate };
 
        const sendSSE = function(clients,body){
            clients.forEach(client => client.response.write(`data: ${body}\n\n`));
        }

        const handlePostPut = function (input, body, db, req, res){
          const path = input.pathname;
          const author = input.author;
          const group = input.group;
          if (input.method == 'POST') {
              if ( path && path.startsWith("/pub/")) {
                if (body.includes('"type":"Delete"')) {
                    render.renderJSON({ status: 'OK' }, res);
                } else {
                    db.insert(input.pathname, input.type, body, author, group, function(result){
                         render.renderJSON(result, res);
                    });
                }
              } else {
                    db.insert(input.pathname, input.type, body, author, group, function(result){
                         render.renderJSON(result, res);
                    });
              }
          } else if (input.method == 'PUT') {
              if (path && path.startsWith("/sub/")) {
                let tmpKey = path.substring(4);
                if (Object.keys(sub).includes(tmpKey)) {
                    sendSSE(sub[tmpKey], body);
                }
                render.renderJSON({"clients": Object.keys(sub).length}, res);
              } else if (input.pathname.startsWith("/metrics/counter")) {
                    db.increment(input.pathname, function(result) {
                       render.renderJSON(result, res);
                    });
              } else {
                    const result = db.update(input.pathname, input.type, body, author, group);
                    if (Object.keys(sub).includes(input.pathname)) {
                        sendSSE(sub[input.pathname], body);
                    }
                    render.renderJSON(result, res);
              }
          }
        }
      
        const redirect = function (loc, res){
            res.writeHead(302, {
                'Location': loc
              });
            res.end();
        }

        const sessionCheck = function (ssid, input, req){
            var ss = crypto.verifySsid(ssid);
            let author = 'public';
            if (ss.sValid){
                author = ss.pubB64;
            }
            let group = author;
            if (input.query.isPublic === 'true'){
                group = 'public';
            }
            if (input.query.isGroup){
                group = input.query.isGroup;
            }
            input.group = group;
            input.author = author;
            input.method = req.method;
        }

        const app = function (req, res) {
            var input = url.parse(req.url, true);
            var q = input.query;
            const path = input.pathname;
            input.type = render.getType(path);
            if (path==="/" && !q.search){
                redirect('/fs/get/home.html', res);
                return;
            }
            var body = '';
            const ssid = getCookie (req.headers.cookie, 'ssid');
            if (ssid === '' && !path.startsWith("/fs/get/reg") && req.method !== 'GET'){
                redirect(`/fs/get/reg/Reg.html#${path}`, res);
                return; 
            }
            sessionCheck(ssid, input, req);
            const author = input.author;
            const group = input.group;

            try{
                if (req.method === 'POST' || req.method === 'PUT') {
                    req.on('data', function (data) {
                        body += data;
                    });
                    req.on('end', function(){ handlePostPut(input, body, db,  req, res) });
                 } else {
                    if(path && path.startsWith("/db/insert")){
                        const data = { type: 'json', value: db.insert(q.path, q.type, q.value) };
                        render.renderData(data, res);
                    } else if (path && path.startsWith("/sub/")) {
                        render.renderSub(sub, path, req, res);
                    } else if(path && path.startsWith("/fs/get")){
                        render.renderFromFS (path, res);
                    } else if(path && path.startsWith("/static/")){
                        render.renderStatic (path, res);
                    } else if(path && path.startsWith("/mp4/get")){
                        render.renderMP4 (path, req, res);
                    } else {
                        render.render (db, author, group, path, q, res);
                    }
                }
            } catch (err){
                console.log(err);
                render.renderJSON(err, res);
                return;
            }  
        
        };

        const server = http.createServer(
          options, app
	      );
        const ssl = https.createServer(options,app);
        server.listen(port);
        ssl.listen(9443);
    }

}

