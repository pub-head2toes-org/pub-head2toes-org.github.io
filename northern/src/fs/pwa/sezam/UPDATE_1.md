# Update 1

Focus on the review of the full sqlite3 DB and search with FTS. The goal is to update the existing plan.

# Consideration details

* The full DB is located in the current file system here: `/home/pi5/share/sezam/sezam.db`
  * `sezam.db` is about 700 MB and should not be checked in into git  
  * The file location should be the configuration parameter
    * One way is to keep this parameter in the `abcd.db`
    * If config not present API will show `NotAvailable` response
* Full DB has also defined FTS and indexes
  * try to adjust the plan based on the available FTS tables and indexes


