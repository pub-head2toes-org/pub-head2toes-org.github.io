# Northern - Improvements - 2

Let's focus on users and authentication

## Registration

### Existing implementation
* Example URL: `/fs/get/reg/Reg.html#/fs/get/keyboard.html`
  * This process checks for the HTTP cookie presence
  * It generates a new crypto key pair (the content of ID Card) if required
  * Offers uploading of an existing ID Card
  * Inserts the ID card into the database with the path: `/id/<pub_key>.json`
  * Mint and drops the cookie with timestamp and signature as proof of authenticated session

### Improvements
* Implement the following improvements
  * Update the 'Reg.html` to save in the username  as part of the ID card content along the pub and priv keys
    * Save the username in local HTML storage, along the pub and priv keys
    * Save user name in the ID Card to DB, too
    * Save user name in the ID Card file for download, too
      * use username as part of the download ID Card file name
    * Offer option to set a passphrase that will be used as AES 256 key to encrypt and decrypt the ID card on download/upload
      * Use 'oo.js` as an example on using the AES encryption/decryption in browser
      * Indicate with `*` in the ID Card filename that the passphrase is set

