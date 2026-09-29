# Objective

* Write the Node JS API that exposes SQL tables that represent the forum posts so that can be presented in the friendly UX through the pure HTML, JS and CSS pages
* Start first by compiling plan

# Considerations

* DB schema can be found in `src/fs/pwa/sezam/csv/schema.sql`
* DB engine is sqlite3
* DB sample `src/fs/pwa/sezam/db/sezam.db`
* DB is connected inside the Node JS app `northern`
* API should have a way to retrieve:
  * user
  * author
  * conference
  * topic
  * message
* API should be exposed as REST API
* API should have ability to set limit on how many rows are retrieved and offset from which row to start retrieval
* `message` table should have a composite key: id, topic_id, seq, reply_seq
  * the goal is to be able to get in correct order messages and also all of the reply that message might have
  * consider finding an optimal way to apply a limit on retrieving messages in a way so that the message reply string is not broken because of the message retrieval limit
* API should also have filtering parameters
  * message
    * by topic
    * by author
    * by year
    * by reply_author
    * by keyword in body
    * by date: from and to date
  * topic
    * by conference
  * user
    * by full_name fragment
    * by city fragment
    * by company fragment
    * by username fragment
  * author
    * by username fragment

