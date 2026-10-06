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
import SqliteDB from './SqliteDB.js';
import SezamApi from './SezamApi.js';
import SezamDB from './SezamDB.js';
import PushApi from './PushApi.js';
import TempApi from './TempApi.js';
import { posix, join, dirname } from 'node:path';
const sub = {};

// The host name Pals is served under (UPDATE_1). An origin is only Pals' own
// if nobody else's page can run on it, and here every user can write a page:
// a database row with no extension is served as HTML. So on this host only the
// app and the sign-in pages run as themselves; every other document is served
// sandboxed, in an origin of its own, with no script.
const PALS_HOST = /^pals\./i;
const PALS_HOME = '/fs/get/pwa/pals/index.html';
const runsOnPalsHost = function (path) {
    const clean = posix.normalize(path);
    return (clean.startsWith('/fs/get/pwa/pals/') && !clean.startsWith('/fs/get/pwa/pals/example/'))
        || clean.startsWith('/fs/get/reg/');
};

export default class Server{
    constructor(port, dbFilePath, sslPort = 9443) {
        this.init(port, dbFilePath, cookie.getCookie, sslPort);
    }

    init(port, dbFilePath, getCookie, sslPort = 9443){
        console.log('init::'+port);
        const db = new SqliteDB (dbFilePath);
        // The archive is opened on the first /api/sezam/ request, not here, so a
        // node that has no archive configured still starts normally.
        const sezam = new SezamApi(db, { render, openDb: resolved => SezamDB.open(resolved) });
        // Its VAPID keys are read, or made, on the first /push/api/ request.
        const push = new PushApi(db, { render, verifySsid: ssid => crypto.verifySsid(ssid) });
        // Temp files are kept in UPLOAD, next to the database file (UPDATE_8).
        const temp = new TempApi(join(import.meta.dirname, dirname(dbFilePath), 'UPLOAD'),
            { render, verifySsid: ssid => crypto.verifySsid(ssid) });

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
                    db.increment(input.pathname, author, group, function(result) {
                       render.renderJSON(result, res);
                    });
              } else {
                    if (Object.keys(sub).includes(input.pathname)) {
                        sendSSE(sub[input.pathname], body);
                    }
                    db.update(input.pathname, input.type, body, author, group, function(result){
                        render.renderJSON(result, res);
                    });
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
            const palsHost = PALS_HOST.test(req.headers.host || '');
            if (path==="/" && !q.search){
                redirect(palsHost ? PALS_HOME : '/fs/get/home.html', res);
                return;
            }
            if (palsHost){
                res.setHeader('X-Content-Type-Options', 'nosniff');
                if (!runsOnPalsHost(path || '')){
                    res.setHeader('Content-Security-Policy', 'sandbox');
                }
            }
            var body = '';
            const ssid = getCookie (req.headers.cookie, 'ssid');
            if (path && PushApi.owns(path)) {
                push.handle(req, res, ssid);
                return;
            }
            if (path && TempApi.owns(path)) {
                temp.handle(req, res, ssid);
                return;
            }
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
                    if (path && SezamApi.owns(path)) {
                        sezam.handle(path, q, req, res);
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
                if (err && err.status){
                    render.renderJSON({ error: err.message }, res, err.status);
                } else {
                    render.renderJSON(err, res);
                }
                return;
            }  
        
        };

        const server = http.createServer(
          options, app
	      );
        const ssl = https.createServer(options,app);
        server.listen(port);
        ssl.listen(sslPort);

        this.db = db;
        this.sezam = sezam;
        this.push = push;
        this.temp = temp;
        this.httpServer = server;
        this.sslServer = ssl;
    }

}

