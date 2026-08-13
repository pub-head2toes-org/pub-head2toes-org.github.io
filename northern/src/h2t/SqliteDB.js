'use strict';

import sqlite3 from 'sqlite3';
import path from 'node:path';
const __dirname = import.meta.dirname;


export default class SqliteDB {
    constructor(dbFilePath) {
        this.dbPath = dbFilePath;
        this.db = new sqlite3.Database(path.join(__dirname + "/" + dbFilePath));
        this.db.run("CREATE TABLE IF NOT EXISTS abcd (path TEXT, type TEXT, value TEXT, counter INTEGER, author TEXT, public TEXT)");
        this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS PathUniqueIndex ON abcd (path)")
    }

    getDBPath (){
        return this.dbPath;
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

      increment (path, author, group, cb){
        let _this = this;
        this.db.serialize(function() {
            try {
            var stmt = _this.db.prepare("UPDATE abcd set counter = counter + 1, type = 'counter' where path = ?");
            stmt.run( path, function (err, row){
                if (err){
                    cb(err);
                    return;
                } else {
                    if (this.changes === 1){
                        cb( {status:'OK', path:path, lastID:this.lastID});
                        return;
                    } else {
                        _this.createCounter(path, author, group, cb);
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

      // First hit on a counter key: create the row already counting this one.
      // Counters do not go through insert(), whose duplicate key fallback is
      // the versioning scheme and would be wrong here.
      createCounter (path, author, group, cb){
        let _this = this;
        this.db.run("INSERT INTO abcd VALUES (?,'counter','',1,?,?)", [path, author, group], function(err){
            if (!err){
                cb({status:'OK', path:path, counter:1});
                return;
            }
            if (err.code !== 'SQLITE_CONSTRAINT'){
                console.log(err);
                cb(err);
                return;
            }
            // Another request created the same counter in between - count on theirs.
            _this.db.run("UPDATE abcd set counter = counter + 1, type = 'counter' where path = ?", [path], function(updateErr){
                if (updateErr){
                    console.log(updateErr);
                    cb(updateErr);
                } else {
                    cb({status:'OK', path:path});
                }
            });
        });
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

