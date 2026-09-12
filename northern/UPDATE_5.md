# Update 5

Focus on DB update function

# Considerations

* review the code to check if any update history is implemented
  * check `src/h2t/SqliteDB.js` and `src/h2t/Server.js`
* implement change in DB update implementation in order to preserve history of updates
  * before updating the record with a given path do first read and insert previous record using following
    * read the old record
    * increment the `counter` and form the new path as `<old_path>/incremented_counter` and do the insert with a new path
    * do the update using the path requested with the new value and the incremented counter 

