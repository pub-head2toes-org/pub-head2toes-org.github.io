'use strict';

import sqlite3 from 'sqlite3';
import path from 'node:path';
const __dirname = import.meta.dirname;


export default class SqliteDB {
    constructor(dbFilePath) {
        this.dbPath = dbFilePath;
        this.writeQueue = Promise.resolve();
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
                    if (err.code === 'SQLITE_CONSTRAINT'){
                        _this.queueWrite(() => _this.insertVersion(path, value));
                    }
                }
                cb(result);
            });
            stmt.finalize();

      });
    } catch (err){
        cb(err);
      }
    }

    // A re-posted key keeps its value; the new one is filed as a version under
    // <path>/<counter + 1> and the key's counter moves to that number - the
    // same slot rule update() uses for its history.
    async insertVersion (path, value){
        try {
            const old = await this.getRow("SELECT counter FROM abcd WHERE path = ?", [path]);
            if (!old){
                return;
            }
            const counter = (old.counter || 0) + 1;
            await this.runSql("INSERT INTO abcd SELECT ?, type, ?, ?, author, public FROM abcd WHERE path = ?", [path + '/' + counter, value, counter, path]);
            await this.runSql("UPDATE abcd set counter = ? where path = ?", [counter, path]);
        } catch (err) {
            console.log(err);
        }
    }

    // Writes that read a counter and then take a slot from it run one after
    // another, so two of them on the same key cannot claim the same slot.
    queueWrite (step){
        this.writeQueue = this.writeQueue.then(step);
        return this.writeQueue;
    }

    // Updates keep the previous version: the old row is copied to
    // <path>/<counter + 1>, then the row at <path> takes the new value and
    // that counter.
    update (path, type, value, author, group, cb = function(){}){
        this.queueWrite(() => this.updateWithHistory(path, type, value, author, group)).then(cb);
      }

      async updateWithHistory (path, type, value, author, group){
        try {
            const old = await this.getRow("SELECT path, type, value, counter, author, public FROM abcd WHERE path = ? and (author = ? or author = 'public')", [path, author]);
            if (!old){
                return {unavailable: path, author: author};
            }
            const counter = (old.counter || 0) + 1;
            // History first: if its slot is taken, the row itself stays untouched.
            await this.runSql("INSERT INTO abcd VALUES (?,?,?,?,?,?)", [path + '/' + counter, old.type, old.value, counter, old.author, old.public]);
            await this.runSql("UPDATE abcd set value = ?, type = ?, public = ?, counter = ? where path = ?", [value, type, group, counter, path]);
            return {status:'OK', path:path, counter:counter};
        } catch (err) {
            console.log(err);
            return err;
        }
      }

      getRow (sql, params){
        return new Promise((resolve, reject) => this.db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
      }

      runSql (sql, params){
        return new Promise((resolve, reject) => this.db.run(sql, params, err => err ? reject(err) : resolve()));
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

