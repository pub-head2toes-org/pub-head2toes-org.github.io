'use strict';

import sqlite3 from 'sqlite3';
import path from 'node:path';
const __dirname = import.meta.dirname;
import HttpClient from './httpClient.js';
const httpClient = new HttpClient(); //require('./httpClient');
var info = {};


export default class SqliteDB {
    constructor(dbFilePath) {
        this.dbPath = dbFilePath;
        this.db = new sqlite3.Database(path.join(__dirname + "/" + dbFilePath));
        this.db.run("CREATE TABLE IF NOT EXISTS abcd (path TEXT, type TEXT, value TEXT, counter INTEGER, author TEXT, public TEXT)");  
        this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS PathUniqueIndex ON abcd (path)")
        this.get("/info", "public", "public", function(err,data){
            if(data){
                let parsed = JSON.parse (data.value);
                info.replicaSet = parsed.replicaSet;
                info.nodeSet = parsed.nodeSet;
            }
        });
    }

    getDBPath (){
        return dbPath;
    }

    insert (path, type, value, author, group, cb){
      let _this = this;
      try{
      this.db.serialize(function() {
            var stmt = _this.db.prepare("INSERT INTO abcd VALUES (?,?,?,?,?,?)");  
            let result = {status:'OK', path:path};
            stmt.run(path, type, value, 0, author, group, function(err){
                if(err){
                    result = err;
			
			console.log(err);
			Promise.resolve(err);
            		stmt = _this.db.prepare("INSERT INTO abcd SELECT path || '/' || counter as newpath, type, ?, counter, author, public from abcd WHERE path = ?");  
            		stmt.run(value, path, function(err){
				if (err){
					console.log(err);
					Promise.resolve(err);
					result = err;
				} else {
            				var stmt = _this.db.prepare("UPDATE abcd set counter = counter + 1 where path = ?");  
            				stmt.run( path, function(err){
						if (err){
							result = err;
						} else {
							result.increment = true;
						}
					});
				}
			});
                }
                cb(result);
            });   
            stmt.finalize();
            
            // _this.insertReplicas(path,type,value); 
                
            
      }); 
    } catch (err){
        cb(err);
      }
    }

    update (path, type, value, author, group){
        let _this = this;
        this.db.serialize(function() {  
            try {
            var stmt = _this.db.prepare("UPDATE abcd set value = ?, type = ?, public = ? where path = ? and (author = ? or author = 'public')");  
            
            stmt.run(value, type, group, path, author);   
            stmt.finalize();
                
            return {status:'OK', path:path};
            } catch (err) {
                return err;
            }
        }); 
      }

      increment (path, cb){
        let _this = this;
        this.db.serialize(function() {
            try {
            var stmt = _this.db.prepare("UPDATE abcd set counter = counter + 1, type = 'counter' where path = ?");  
            stmt.run( path, function (err, row){
                if (err){
                    _this.insert(path, 'counter', 0, cb);
                    return;
                } else {
                    if (this.changes === 1){
                        cb( {status:'OK', path:path, lastID:this.lastID});
                        return;
                    } else {
                        _this.insert(path, 'counter', 0, cb);
                        return;
                    }
                }
            });   
            stmt.finalize();
                
            } catch (err) {
                cb(err);
            }
        }); 
      }

    insertReplicas (path, type, value){
        try{
            for(i=0; replicaSet && i<replicaSet.length; i++){
                let options = {
                    host : replicaSet[i].host,
                    port : 9090,
                    path : '/db/insert?path='+path+'&type='+type+'&value='+value,
                    method : 'GET' 
                };
            httpClient.execute(options, function (err, data){
                if(err){
                    //TODO set sync trigger
                    console.log(err);
                }
            });
            }
        } catch (err){
            //TODO set sync trigger
            console.log(err);
        }
    }

    get (path, author, group, cb){
        let _this = this;
        this.db.serialize(function() {
            _this.db.get("SELECT path, type, value, counter, author, public FROM abcd WHERE path = ? and (author = ? or public = 'public' or public = ?)",[path, author, group], function(err, row) {  
            if (err){
                cb( {err:"'+err+'"});
            } else {
                if (row){
                    cb (row);
                } else {
                    cb({unavailable: path, author: author});
                }
            }
        });  
      }); 
    }

    search (path, author, offset, group, cb){
        let _this = this;
        _this.limitedData = [];
        this.db.serialize(function() {
            _this.db.all("SELECT path, type, counter, author, public FROM abcd WHERE path like ? and (author = ? or public = 'public' or public = ?) order by path desc limit 100 offset ?",[path, author, group, offset], function(err, row) {  
            if (err){
                cb( {err:"'+err+'"});
            } else {
                if (row){
                    cb (row);
                } else {
                    cb({unavailable: path});
                }
            }
        });  
      }); 
    }

    searchPlus (path, author, offset, group, cb){
	console.log('db.searchPlus='+path);
        let _this = this;
        _this.limitedData = [];
        this.db.serialize(function() {
            _this.db.all("SELECT path, type, value, counter, author, public FROM abcd WHERE path like ? and (author = ? or public = 'public' or public = ?) order by path desc limit 100 offset ?",[path, author, group, offset], function(err, row) {  
            if (err){
                cb( {err:"'+err+'"});
            } else {
                if (row){
                    cb (row);
                } else {
                    cb({unavailable: path});
                }
            }
        });  
      }); 
    }


    keyword (path, keyword, author, offset, group, cb){
	console.log('db.path='+path);
	console.log('db.keyword='+keyword);
        let _this = this;
        _this.limitedData = [];
        this.db.serialize(function() {
            _this.db.all("SELECT path, type, value, counter, author, public FROM abcd WHERE path like ? and value like ? and (author = ? or public = 'public' or public = ?) order by path desc limit 100 offset ?",[path+'%', keyword, author, group, offset], function(err, row) {  
            if (err){
                cb( {err:"'+err+'"});
            } else {
                if (row){
                    cb (row);
                } else {
                    cb({unavailable: path});
                }
            }
        });  
      }); 
    }


}

