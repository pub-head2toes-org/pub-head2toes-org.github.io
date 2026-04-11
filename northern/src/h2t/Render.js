'use strict';

import * as pathModule from 'node:path';
const __dirname = import.meta.dirname;
import fs from 'node:fs';

export default class Render {
    render(db, author, group, path, q, res){
        let _res = res;
        let _this = this;
        if (q && q.search){
            let offset = 0;
            if (q.offset){
                offset = parseInt(q.offset, 10);
            }
            db.search(path+q.search, author, offset, group, function(data){
                _this.renderSearchResults(data, _res);
            });
	} else if (q && q.searchPlus){
	    console.log('searchPlus='+q.searchPlus);
            let offset = 0;
            if (q.offset){
                offset = parseInt(q.offset, 10);
            }
            db.searchPlus(path+q.searchPlus, author, offset, group, function(data){
                _this.renderSearchResults(data, _res);
            });
	} else if (q && q.keyword){
	    console.log('keyword='+q.keyword);
            let offset = 0;
            if (q.offset){
                offset = parseInt(q.offset, 10);
            }
            db.keyword(path, q.keyword, author, offset, group, function(data){
                _this.renderSearchResults(data, _res);
            });
        } else {
            db.get(path, author, group, function(data){
                _this.renderData(data, _res);
            });
        }
    }

    renderFromFS(path, res){
        let data = {};
        data.filePath = pathModule.join(__dirname + "/../" + path.replace('/fs/get','/fs/'));
        data.value = fs.readFileSync (pathModule.join(__dirname + "/../" + path.replace('/fs/get','/fs/'))).toString();
        data.type = this.getType(path);
        this.renderData (data, res);
    }

    renderStatic(path, res){
        let data = {};
        data.value = fs.readFileSync (pathModule.join(__dirname + "/../" + path));
        data.type = this.getType(path);
        this.renderData (data, res);
    }

    renderWellKnown(path, res){
        let data = {};
        data.value = fs.readFileSync (pathModule.join(__dirname + "/../" + path)).toString();
        data.type = 'html';
        this.renderData (data, res);
    }

    renderMP4(path, req, res){
            var file = pathModule.join(__dirname + "/../../../" + path.replace('/mp4/get','/mp4/'));
            var filename = pathModule.basename(file);
            var stats = fs.statSync(file);
            var extension = path.split('.').reverse()[0];
            if (extension === 'mp4') {
              // gotta chunk the response if serving an mp4
              var range = req.headers.range;
              var total = stats.size;
              var partialstart = "0";
              var partialend = null;
              if(range){             
                var parts = range.replace(/bytes=/, "").split("-");
                partialstart = parts[0];
                partialend = parts[1];
              }
              
              var start = parseInt(partialstart, 10);
              var end = partialend ? parseInt(partialend, 10) : total - 1;
              var chunksize = (end - start) + 1;
              var mimeType = 'video/mp4';
              res.writeHead(206, {   
                // 'Content-Disposition': + filename,      
                'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': mimeType
              });
              var fileStream = fs.createReadStream(file, {
                  start: start,
                  end: end
              });
              fileStream.pipe(res);
              res.on('close', function() {
                console.log('response closed');
                if (res.fileStream) {
                    res.fileStream.unpipe(this);
                    if (this.fileStream.fd) {
                        fs.close(this.fileStream.fd);
                    }
                }
              });
            } else {
              var mimeType = 'text/plain; charset=utf-8';
              res.writeHead(200, {'Content-Type': mimeType});
              var fileStream = fs.createReadStream(file);
              fileStream.pipe(res);
            }
        
            return;
          
    }

    getType (path){
        let tmpArr = path.split(".");
        if (tmpArr && tmpArr.length>1){
            return tmpArr[tmpArr.length-1];
        } else {
            return "txt";
        }
    }

    renderSearchResults (data, res){
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(data));
    }

    renderSub(sub, path, req, res) {
        const headers = {
            'Content-Type': 'text/event-stream',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache'
        };
        res.writeHead(200, headers);

        let subList;
        let tmpKey = path.substring(4);
        if (Object.keys(sub).includes(tmpKey)) {
            subList = sub[tmpKey];
        } else {
            subList = [];
        }
        let clientId = Date.now();
        let client = {
            id: clientId,
            response: res
        };
        subList.push(client);
        sub[tmpKey] = subList;
        req.on('close', () => {
            if (sub[tmpKey]) {
                subList = sub[tmpKey];
                subList = subList.filter(client => client.id !== clientId);
                sub[tmpKey] = subList;
            }
        });

        res.write(`data: {"status":"OK"}\n\n`);
    }

    renderJSON (data, res){
         res.writeHead(200, {'Content-Type': 'application/json'});
         res.end(JSON.stringify(data));
    }

    renderData (data, res){
        if(data.type && data.type === 'html'){
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(data.value);
        } else if(data.type && data.type === 'counter'){
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(""+data.counter);
        } else if(data.type && data.type === 'xml'){
            res.writeHead(200, {'Content-Type': 'text/xml'});
            res.end(data.value);
        } else if(data.type && data.type === 'md'){
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(data.value);
        } else if(data.type && data.type === 'txt'){
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(data.value);
        } else if(data.type && data.type === 'tsv'){
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(data.value);
        } else if(data.type && data.type === 'json'){ 
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(data.value);
        } else if(data.type && data.type === 'mp3'){ 
            const stat = fs.statSync(data.filePath);
            res.writeHead(200, {'Content-Type': 'audio/mpeg', 'Content-Length': stat.size});
            const readStream = fs.createReadStream(data.filePath);
            readStream.pipe(res);
        } else if(data.type && data.type === 'm4a'){ 
            const stat = fs.statSync(data.filePath);
            res.writeHead(200, {'Content-Type': 'audio/mp4', 'Content-Length': stat.size});
            const readStream = fs.createReadStream(data.filePath);
            readStream.pipe(res);
        } else if(data.type && data.type === 'js'){ 
            res.writeHead(200, {'Content-Type': 'application/javascript'});
            res.end(data.value);
        } else if(data.type && data.type === 'css'){ 
            res.writeHead(200, {'Content-Type': 'text/css'});
            res.end(data.value);
	} else if(data.type && data.type === 'png'){
	    res.writeHead(200, {'Content-Type': 'image/png'});
	    res.end(data.value);
	} else if(data.type && data.type === 'jpeg'){
	    res.writeHead(200, {'Content-Type': 'image/jpeg'});
	    res.end(data.value);
	} else if(data.type && data.type === 'zip'){
	    res.writeHead(200, {'Content-Type': 'application/zip'});
	    res.end(data.value);
	} else {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(data));
        }
    }
}
