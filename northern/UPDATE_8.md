# Northern - Update 8

Focus on the new feature: image or any file upload download for temporary hold

## Implementation considerations
* File upload/download API for temp files
  * Files can be uploaded/downloaded from PWA Pals for example
  * Files should be saved in a temp space in the file system with predefined maximum size
    * Temp space should be folder `UPLOAD` in the same folder where the `abcd.db` is located
    * Define the max space for files to be 500MB
    * Define the max file size limit to 50MB
    * File can be for example JPEG image but it can be also be an AES encrypted blob of the JPEG image 
    * File should be saved with random string as a filename and that random string is passed back in response to the service caller
      * File can only be downloaded with random string returned on upload 
    * If the file is downloaded the file should be marked for deletion
    * Not downloaded files will be marked for deletion after one month or if temp space is running low (below 10%)
    * All files marked for deletion should be purged when space size drops below 30%
      * If incoming upload file size will will be bringing total use of space to or over 90% try first to purge the marked for deletion files

