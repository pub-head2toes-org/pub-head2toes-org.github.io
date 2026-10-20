# Northern - Update 8

Focus of this update is on `src/fs/reg/Reg.html`

## Considerations
* Provide the `Logout` link in case it is detected the previous signed in user
  * Also add the logaout  link to PWA Pals in the `Settings` page
* Utilize the non-extractable signing key stored IndexDB to provide the auto-signin for expired session cookie
  * When the expired cookies are detected while lended on the `Reg.html` use the key for signing in IndexDB to drop a new cookie and redirect to the end destination
