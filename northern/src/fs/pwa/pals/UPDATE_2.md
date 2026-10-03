# UPDATE 2

Focus: Redo message sealing to achieve zero-trust.
Before implementing review the proposed changes for the security completeness. 

# Implementation details

* Modify reg/sign to in addition of the current steps do add the priv key into IndexDB as non-retrieval key
  * Alternative is to derive AES keys for all pub keys in the pals list using the priv key on reg/sign and store those in IndexDB
    * This would also mean that for adding a new pal the reg/sign would be needed to load the priv key from file 
* Modify the message sealing to use AES key derived from sender priv key and recipient pub key to encrypt messages instead of VAPID private key
* Modify the opening of the message to happen in the browser instead of sending it to the server
